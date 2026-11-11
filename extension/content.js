// NetParty content script (Netflix, JioHotstar, YouTube, Prime Video, HBO Max, Crunchyroll, SonyLIV, and since 2.0 any page the user chose
// to sync: see anyvideo.js). Owns: the party connection, clock sync, playback sync, text chat (emoji, GIFs, links),
// reactions, voice and video chat (WebRTC mesh) and the in-page overlay.
(() => {
  if (window.__netpartyLoaded) return;
  window.__netpartyLoaded = true;

  const TAG = "netparty";
  const SEEK_THRESHOLD_MS = 1000; // apply a remote seek when we're this far off
  const DRIFT_THRESHOLD_MS = 2000; // periodic soft correction while playing
  const SUPPRESS_MS = 1200; // ignore our own player events after applying a remote action
  const log = (...a) => console.debug("[NetParty]", ...a);

  // ---------------------------------------------------------------- helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  // ---- platforms. A party's videoId is the Netflix title id ("81234567"),
  // "hs:" + the JioHotstar watch path ("hs:/in/shows/<show>/<id>/<ep>/<id>/watch"),
  // "yt:" + the YouTube video id ("yt:dQw4w9WgXcQ", from /watch?v=…),
  // or "pv:" + the Prime Video title page ("pv:www.primevideo.com/detail/<id>",
  // "pv:www.amazon.co.uk/gp/video/detail/<ASIN>"), while its player is open,
  // "hm:" + the HBO Max watch ids ("hm:<uuid>" or "hm:<uuid>/<uuid>", from play.hbomax.com/video/watch/…, 2.2),
  // "cr:" + the Crunchyroll episode id ("cr:GY0973WVY", from www.crunchyroll.com/watch/<id>/<slug>, 2.2),
  // "sl:" + the SonyLIV title path ("sl:/shows/<show>-<id>/<episode>-<id>", "sl:/movies/<slug>-<id>", 2.2),
  // or "av:" + 16 random characters for a video on any other page (2.0). An "av:" id names no site and is
  // never turned into a link: the page's address travels end-to-end encrypted ("page", see anyPage).
  // Same shapes as validVideoId in server/core.js: anything else is never turned into a link.
  const PRIME_HOSTS = [
    "www.primevideo.com",
    ...["com", "co.uk", "de", "co.jp", "in", "ca", "com.au", "fr", "it", "es", "com.br", "com.mx", "nl"].map((t) => "www.amazon." + t),
  ];
  const PV_RE = /^pv:([a-z0-9.-]+)(\/(?:detail|dp|gp\/video\/detail)\/[A-Za-z0-9._-]{6,100})$/;
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const HM_RE = new RegExp(`^hm:${UUID}(\\/${UUID})?$`);
  const SL_RE = /^sl:\/(shows|sports|movies|clip|trailer|music-videos)(\/[a-z0-9-]{1,120}-\d{4,})?\/[a-z0-9-]{0,120}-?\d{5,}$/;
  function validVideoId(v) {
    if (typeof v !== "string" || !v || v.length > 512) return false;
    if (/^\d{1,12}$/.test(v)) return true;
    if (v.startsWith("yt:")) return /^yt:[A-Za-z0-9_-]{11}$/.test(v);
    if (v.startsWith("av:")) return /^av:[A-Za-z0-9_-]{16}$/.test(v);
    if (v.startsWith("hs:")) return /^hs:(\/[A-Za-z0-9._~%-]+)+\/\d{5,}\/watch$/.test(v);
    if (v.startsWith("hm:")) return HM_RE.test(v);
    if (v.startsWith("cr:")) return /^cr:[A-Z0-9]{6,16}$/.test(v);
    if (v.startsWith("sl:")) return SL_RE.test(v);
    const pv = PV_RE.exec(v);
    if (pv) return pv[1] === "www.primevideo.com" ? !pv[2].startsWith("/gp/") : PRIME_HOSTS.includes(pv[1]) && pv[2].startsWith("/gp/video/detail/");
    return false;
  }
  // "Sync any video" (2.0): set by any-mode.js when the user chose to sync this page (not a supported service)
  const IS_ANY = window.__netpartyAny === true;
  const isAv = (v) => typeof v === "string" && v.startsWith("av:") && validVideoId(v);
  const IS_HOTSTAR = !IS_ANY && /(^|\.)(jio)?hotstar\.com$/.test(location.hostname);
  const IS_YT = !IS_ANY && /(^|\.)youtube\.com$/.test(location.hostname);
  const IS_PRIME = !IS_ANY && PRIME_HOSTS.includes(location.hostname);
  // 2.2: HBO Max (play.hbomax.com; play.max.com is its old address), Crunchyroll, SonyLIV
  const IS_HBO = !IS_ANY && (location.hostname === "play.hbomax.com" || location.hostname === "play.max.com");
  const IS_CR = !IS_ANY && location.hostname === "www.crunchyroll.com";
  const IS_SL = !IS_ANY && location.hostname === "www.sonyliv.com";
  const SITE_NAME = IS_ANY ? "this page" : IS_HOTSTAR ? "JioHotstar" : IS_YT ? "YouTube" : IS_PRIME ? "Prime Video" : IS_HBO ? "HBO Max" : IS_CR ? "Crunchyroll" : IS_SL ? "SonyLIV" : "Netflix";
  // sites whose <video> NetParty drives straight from here (no page script): YouTube, Prime Video, HBO Max, SonyLIV
  const DIRECT = IS_YT || IS_PRIME || IS_HBO || IS_SL;
  // the biggest <video> showing on the page (players keep spare or preview <video>s around)
  const shownVideos = () =>
    [...document.querySelectorAll("video")].filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  const largest = (vids) => {
    if (vids.length < 2) return vids[0] || null;
    const area = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    return vids.sort((a, b) => area(b) - area(a))[0];
  };
  // Prime Video plays titles in an overlay player on the title's own page (the URL stays the
  // title page). The player counts as open while one of its containers is on screen with a
  // <video> in it; the title page's muted hero trailer isn't inside those containers.
  const PRIME_PLAYER = ["#dv-web-player", ".webPlayerSDKContainer", ".webPlayerContainer"];
  function primePlayer() {
    for (const sel of PRIME_PLAYER)
      for (const box of document.querySelectorAll(sel)) {
        const r = box.getBoundingClientRect();
        if (r.width < 200 || r.height < 120) continue;
        const cs = getComputedStyle(box);
        if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") < 0.1) continue;
        const vids = [...box.querySelectorAll("video")].filter((v) => {
          const q = v.getBoundingClientRect();
          return q.width > 0 && q.height > 0;
        });
        if (vids.length) return { box, video: largest(vids) };
      }
    return null;
  }
  // the title in the address bar: /detail/<id> or /dp/<id> on primevideo.com (also under
  // /region/<r>/ or /-/<lang>/), /gp/video/detail/<ASIN> on the Amazon stores
  function primeTitlePath() {
    if (!IS_PRIME) return null;
    const p = location.pathname;
    if (location.hostname === "www.primevideo.com") {
      const m = p.match(/\/(detail|dp)\/([A-Za-z0-9._-]{6,100})(?=\/|$)/);
      return m ? `/${m[1]}/${m[2]}` : null;
    }
    const m = p.match(/\/gp\/video\/detail\/([A-Za-z0-9._-]{6,100})(?=\/|$)/);
    return m ? `/gp/video/detail/${m[1]}` : null;
  }
  // SonyLIV: title pages and the player share one address (the player adds ?watch=true); a page counts as the
  // player while it says so in the address or a big <video> is showing
  const slPlayerOpen = () =>
    new URLSearchParams(location.search).get("watch") === "true" || shownVideos().some((v) => v.getBoundingClientRect().width >= innerWidth * 0.6);
  // Crunchyroll: the episode's player is an iframe from static.crunchyroll.com (its "vilos" player); a newer
  // player may put the <video> in the page itself. Both work.
  const crFrameEl = () => document.querySelector('iframe[src*="//static.crunchyroll.com/"]');
  const videoIdFromUrl = () => {
    // any page: the party's own id (or a placeholder before there is one). The page counts as the
    // "watch page" for as long as NetParty runs on it; the video itself is found by anyV.
    if (IS_ANY) return isAv(party.state?.videoId) ? party.state.videoId : "av:local";
    if (IS_PRIME) {
      const t = primeTitlePath();
      const v = t && "pv:" + location.hostname + t;
      return v && validVideoId(v) && primePlayer() ? v : null;
    }
    if (IS_HBO) {
      const m = location.pathname.match(/^\/video\/watch\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?\/?$/);
      const v = m && "hm:" + m[1] + (m[2] ? "/" + m[2] : "");
      return v && validVideoId(v) ? v : null;
    }
    if (IS_CR) {
      // /watch/<id>/<slug>, also under a language prefix (/fr/watch/…, /pt-br/watch/…)
      const m = location.pathname.match(/^(?:\/[a-z]{2}(?:-[a-z]{2,4})?)?\/watch\/([A-Z0-9]{6,16})(?:\/|$)/);
      return m ? "cr:" + m[1] : null;
    }
    if (IS_SL) {
      const v = "sl:" + location.pathname.replace(/\/+$/, "");
      return validVideoId(v) && slPlayerOpen() ? v : null;
    }
    if (IS_YT) {
      if (location.pathname !== "/watch") return null; // Shorts, live chat pop-outs etc. aren't supported
      const v = new URLSearchParams(location.search).get("v");
      return v && /^[\w-]{11}$/.test(v) ? "yt:" + v : null;
    }
    if (!IS_HOTSTAR) return (location.pathname.match(/^\/watch\/(\d+)/) || [])[1] || null;
    const path = location.pathname.replace(/\/+$/, "");
    return /\/\d{5,}\/watch$/.test(path) ? "hs:" + path : null;
  };
  // compare by content id so slug, language-prefix or store differences don't matter
  const videoKey = (v) =>
    v && v.startsWith("hs:")
      ? "hs:" + (v.match(/(\d+)\/watch$/) || [])[1]
      : v && v.startsWith("pv:")
        ? "pv:" + v.split("/").pop()
        : v && v.startsWith("hm:")
          ? v.slice(0, 39) // the first id names the episode
          : v && v.startsWith("sl:")
            ? "sl:" + (v.match(/(\d+)$/) || [])[1]
            : v;
  const sameVideo = (a, b) => (IS_ANY ? isAv(b) : videoKey(a) === videoKey(b));
  // null for anything that isn't a known title shape (a party member can't send us elsewhere)
  const watchUrl = (videoId, roomId) => {
    if (!validVideoId(videoId) || !/^[a-z0-9]{4,16}$/.test(String(roomId))) return null;
    if (videoId.startsWith("av:")) return null; // its address is encrypted (party.page)
    if (videoId.startsWith("yt:")) return `https://www.youtube.com/watch?v=${videoId.slice(3)}&npParty=${roomId}`;
    // Prime Video: autoplay=1 opens the player on the title page
    if (videoId.startsWith("pv:")) return `https://${videoId.slice(3)}?autoplay=1&npParty=${roomId}`;
    if (videoId.startsWith("hm:")) return `https://play.hbomax.com/video/watch/${videoId.slice(3)}?npParty=${roomId}`;
    if (videoId.startsWith("cr:")) return `https://www.crunchyroll.com/watch/${videoId.slice(3)}?npParty=${roomId}`;
    if (videoId.startsWith("sl:")) return `https://www.sonyliv.com${videoId.slice(3)}?watch=true&npParty=${roomId}`;
    return (videoId.startsWith("hs:") ? "https://www.hotstar.com" + videoId.slice(3) : `https://www.netflix.com/watch/${videoId}`) + `?npParty=${roomId}`;
  };
  const HAS_ADS = IS_YT || IS_PRIME || IS_HBO || IS_CR || IS_SL;
  // an ad marker that is on screen and says something (players keep empty ad containers around)
  const shownAd = (sel, root = document) =>
    [...root.querySelectorAll(sel)].some((n) => {
      const r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(n);
      return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.05 && (!!n.textContent.trim() || !!n.querySelector("video, iframe"));
    });
  // 2.2 ad markers. HBO Max (ad tiers): the player's ad badge / countdown. SonyLIV: Google IMA's ad layer over the
  // player. Crunchyroll: reported by the player frame (see anyvideo.js), or the same markers in the page.
  // Built from public page structure and checked against test pages only (we can't sign in to these services).
  const HBO_AD = '[data-testid*="ad-badge" i], [data-testid*="ad_badge" i], [data-testid*="ad-countdown" i], [class*="AdBadge"], [class*="AdCountdown"]';
  const SL_AD = ".ima-ad-container, .videoAdUi, [class*=\"ad-break-overlay\" i], [data-testid*=\"ad-break\" i]";
  const CR_AD = '[data-testid*="ad-indicator" i], [class*="ad-indicator" i], [title="Advertisement"]';
  // YouTube and Prime Video play ads in the main player: no sync while one is on screen
  const adPlaying = () => {
    if (IS_HBO) return shownAd(HBO_AD);
    if (IS_SL) return shownAd(SL_AD);
    if (IS_CR) return crFrame.ad || shownAd(CR_AD);
    if (IS_PRIME) {
      // Prime's player shows an ad countdown ("Ad 0:15") during ad breaks
      const box = primePlayer()?.box;
      const n = box?.querySelector('[class*="atvwebplayersdk-ad-timer"], [class*="atvwebplayersdk-adtimeindicator"], [class*="atvwebplayersdk-ad-indicator"]');
      return !!n && n.getBoundingClientRect().width > 0 && !!n.textContent.trim();
    }
    if (!IS_YT) return false;
    if (document.querySelector("#movie_player.ad-showing, #movie_player.ad-interrupting")) return true;
    const ads = document.querySelector("#movie_player .video-ads");
    return !!ads && [...ads.children].some((c) => c.getBoundingClientRect().height > 0);
  };
  // what's playing, for GIF suggestions ("relevant to the film")
  const titleCache = { vid: null, title: "" };
  function readTitle() {
    let t = "";
    if (IS_ANY) {
      t = document.querySelector('meta[property="og:title"]')?.content || document.title || "";
      t = t.split(/\s[|–-]\s/)[0];
    } else if (IS_PRIME) {
      const box = primePlayer()?.box;
      t = box?.querySelector('[class*="atvwebplayersdk-title-text"]')?.textContent || "";
      if (!t.trim()) t = document.querySelector('meta[property="og:title"]')?.content || document.querySelector("h1")?.textContent || "";
      t = t.replace(/^(watch|prime video:)\s+/i, "").replace(/\s*[|–-]\s*(prime video|amazon\.\S+).*$/i, "");
    } else if (IS_YT) {
      t = document.querySelector("ytd-watch-metadata h1, h1.ytd-watch-metadata, #above-the-fold #title h1")?.textContent || "";
      if (!t.trim()) t = document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube\s*$/i, "");
    } else if (IS_HBO) {
      t = document.querySelector('[data-testid="player-ux-asset-title"], [class^="Title-Beam-Web-Ent"]')?.textContent || "";
      if (!t.trim()) t = document.title.replace(/\s*[|•–-]\s*(HBO\s*)?Max.*$/i, "").replace(/^(HBO\s*)?Max$/i, "");
    } else if (IS_CR) {
      t = document.querySelector('[data-t="episode-title"], h1.title, .erc-current-media-info h1')?.textContent || "";
      if (!t.trim()) t = (document.querySelector('meta[property="og:title"]')?.content || document.title || "").replace(/^watch\s+/i, "").replace(/\s*[|–-]\s*crunchyroll.*$/i, "");
    } else if (IS_SL) {
      t = document.querySelector('[class*="playerTitle"], [class*="player-title"], [class*="contentTitle"]')?.textContent || "";
      if (!t.trim()) t = (document.querySelector('meta[property="og:title"]')?.content || document.title || "").replace(/^watch\s+(latest\s+)?/i, "").replace(/\s*(full\s+hd\s+)?(movie|episode|tv series|tv show)?\s*online.*$/i, "").replace(/\s*[|–-]\s*sony\s*liv.*$/i, "");
    } else if (IS_HOTSTAR) {
      t = document.querySelector('meta[property="og:title"]')?.content || document.title || "";
      t = t.split(/\s[|–-]\s/)[0].replace(/^watch\s+/i, "").replace(/\s+(full\s+)?(movie|episode|season\s*\d*)?\s*online.*$/i, "");
      if (/^(jio)?hotstar$/i.test(t.trim())) t = "";
    } else {
      const box = document.querySelector('[data-uia="video-title"]');
      t = box?.querySelector("h4")?.textContent || box?.textContent || "";
      if (!t.trim() && !/^netflix$/i.test(document.title.trim())) t = document.title.replace(/\s*[-|]\s*Netflix\s*$/i, "");
    }
    return t.replace(/\s+/g, " ").trim().slice(0, 60);
  }
  const currentTitle = () => {
    const vid = videoIdFromUrl();
    if (titleCache.vid !== vid) Object.assign(titleCache, { vid, title: "" });
    const t = readTitle();
    if (t) titleCache.title = t; // Netflix only shows the title while the controls are up
    return titleCache.title;
  };
  // the main player <video>: skip tiny previews/ads by preferring the largest one on screen
  const mainVideo = () =>
    IS_ANY ? anyV.video : IS_PRIME ? primePlayer()?.video || null : IS_CR ? crFrame.topVideo() : DIRECT && !IS_YT ? largest(shownVideos()) : largest([...document.querySelectorAll("video")]);
  const fmt = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  };
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) n.setAttribute(k, v);
    }
    for (const k of kids) n.append(k);
    return n;
  };

  // --------------------------------------------- end-to-end encryption
  // Party chat (text, GIFs), reactions, names, pictures and voice-call setup are encrypted here
  // with the party's room key: 256-bit AES-GCM from WebCrypto, made by the host's browser. The key
  // travels only in the invite link's #fragment and lives in the participants' browsers (session
  // storage of the extension, per tab). The server sees ciphertext only.
  // Ciphertext: base64url(0x01 | 12-byte random IV | AES-GCM ciphertext + tag). The plaintext is
  // JSON, padded with spaces to a multiple of 64 bytes. Additional data binds each ciphertext to
  // the party, the kind of message and the sender's public id, so the server can't replay it into
  // another party, pass it off as another kind, or re-attribute it to someone else.
  const E2E = {
    NEED_LINK: "Paste the full invite link — the code alone can't unlock the encrypted chat.",
    BAD_KEY: "Can't decrypt messages — check your invite link (ask for the full link again).",
    OLD_ROOM: "This party was started with an older NetParty that doesn't encrypt chat. Ask the host to update NetParty and start a new party.",
    OLD_SERVER: "This party server doesn't support encrypted chat. Update the server, or use the default (wss://netparty.tech).",
  };
  // same limits as the server (server/core.js): ciphertext length for chat / profile / reaction / signal
  const ctChars = (n) => Math.ceil(((1 + 12 + 16 + n) * 4) / 3);
  const pad64 = (n) => Math.ceil(n / 64) * 64;
  // profile (2.2): { name, avatar (emoji), hd? ("av:<slug>"), img? (a data: photo up to IMG_MAX characters) }
  const IMG_MAX = 12400;
  const CT_MAX = { chat: ctChars(pad64(500 * 6 + 64)), profile: ctChars(pad64(24 * 2 * 6 + 16 * 6 + 64 + 64 + IMG_MAX + 64)), react: ctChars(pad64(16 * 6 + 32)), signal: 32768 };
  const e2e = (() => {
    const enc = new TextEncoder();
    const b64u = (bytes) => {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const unb64u = (s) => {
      if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
      try {
        const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      } catch {
        return null;
      }
    };
    // 43 base64url characters that decode to exactly 32 bytes (and re-encode the same way)
    const validKey = (s) => {
      if (typeof s !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(s)) return false;
      const b = unb64u(s);
      return !!b && b.length === 32 && b64u(b) === s;
    };
    const importKey = (s) => crypto.subtle.importKey("raw", unb64u(s), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const aad = (room, kind, pid) => enc.encode(`netparty/e2ee/v1|${room}|${kind}|${pid}`);
    let cur = null; // { room, keyStr, key: CryptoKey }
    async function sealWith(key, room, kind, pid, obj) {
      const json = enc.encode(JSON.stringify(obj));
      const pt = new Uint8Array(Math.max(64, pad64(json.length))).fill(0x20);
      pt.set(json);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(room, kind, pid), tagLength: 128 }, key, pt));
      const out = new Uint8Array(13 + ct.length);
      out[0] = 1;
      out.set(iv, 1);
      out.set(ct, 13);
      return b64u(out);
    }
    async function openWith(key, room, kind, pid, s) {
      const b = unb64u(s);
      if (!key || !b || b.length < 13 + 16 || b[0] !== 1) return null;
      try {
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(1, 13), additionalData: aad(room, kind, pid), tagLength: 128 }, key, b.subarray(13));
        const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pt));
        return v && typeof v === "object" && !Array.isArray(v) ? v : null;
      } catch {
        return null;
      }
    }
    const CHECK = { check: "netparty" };
    return {
      genKey: () => b64u(crypto.getRandomValues(new Uint8Array(32))),
      validKey,
      get ready() {
        return !!cur?.room;
      },
      get keyStr() {
        return cur?.keyStr || null;
      },
      async use(room, keyStr) {
        if (!validKey(keyStr)) throw new Error(E2E.NEED_LINK);
        cur = { room, keyStr, key: await importKey(keyStr) };
      },
      setRoom(room) {
        if (cur) cur.room = room;
      },
      clear() {
        cur = null;
      },
      // encrypted known value the host stores with the party: lets a guest's browser tell
      // whether its invite key is the party's key before joining
      makeCheck: () => sealWith(cur.key, "", "check", "", CHECK),
      async checkKey(keyStr, kc) {
        if (!validKey(keyStr) || typeof kc !== "string") return false;
        const v = await openWith(await importKey(keyStr), "", "check", "", kc);
        return v?.check === CHECK.check;
      },
      seal: (kind, pid, obj) => sealWith(cur.key, cur.room, kind, pid, obj),
      open: (kind, pid, s) => (cur?.room ? openWith(cur.key, cur.room, kind, pid, s) : Promise.resolve(null)),
    };
  })();

  // ---- checks on decrypted content (the server can't see it, so it can't check it any more)
  const AVATAR_LIST = globalThis.NP_EMOJI?.avatars || [];
  const segmenter = Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
  function isSingleEmoji(s, maxUnits = 16) {
    if (typeof s !== "string" || !s || s.length > maxUnits) return false;
    if (!/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(s)) return false;
    if (/[\p{L}\p{N}\p{P}\p{Z}\p{Cc}<>`$^|~=+]/u.test(s)) return false;
    if (segmenter) {
      let n = 0;
      for (const _ of segmenter.segment(s)) if (++n > 1) return false;
    }
    return true;
  }
  const cleanAvatar = (a) => (AVATAR_LIST.includes(a) || isSingleEmoji(a, 8) ? a : null);
  // 2.2 HD pictures: "av:<slug>" of a bundled file (avatars/av-<slug>.webp), nothing else
  const HD = new Map((globalThis.NP_EMOJI?.hd || []).map((x) => [x.id, x]));
  const cleanHd = (a) => (typeof a === "string" && a.startsWith("av:") && HD.has(a.slice(3)) ? a : null);
  // 2.2 profile photo: a small data: image (WebP / JPEG / PNG), never a URL; it's decoded before it's shown
  const IMG_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;
  const cleanImg = (s) => (typeof s === "string" && s.length <= IMG_MAX && IMG_RE.test(s) ? s : null);
  // names: no control or invisible direction characters, one line, at most 24 characters
  const cleanName = (s) =>
    typeof s === "string" ? [...s.replace(/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu, "").replace(/\s+/g, " ").trim()].slice(0, 24).join("") : "";
  // KLIPY media hosts (same list as KLIPY_MEDIA_HOSTS in server/core.js)
  const GIF_HOSTS = ["static.klipy.com", "static1.klipy.com", "static2.klipy.com"];
  function isKlipyMediaUrl(s) {
    if (typeof s !== "string" || s.length > 600) return false;
    let u;
    try {
      u = new URL(s);
    } catch {
      return false;
    }
    return u.protocol === "https:" && !u.username && !u.password && !u.port && GIF_HOSTS.includes(u.hostname) && u.href === s;
  }
  const dim = (n) => (Number.isInteger(n) && n > 0 && n <= 4096 ? n : null);
  // 2.1: chat lines carry a random message id ("mid") inside the encryption, so replies and
  // reactions can point at them. Lines without one (2.0.x senders) get an id made from the end of
  // their ciphertext (the AES-GCM tag), which every member sees the same way.
  const MID_RE = /^[A-Za-z0-9_~-]{8,24}$/;
  const MID_ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const newMid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => MID_ABC[b & 63]).join("");
  const ctMid = (ct) => (typeof ct === "string" && ct.length >= 16 ? "~" + ct.slice(-16) : null);
  const SNIPPET = 80; // characters of the quoted message kept in a reply
  // one line of text for a reply quote: no control or invisible characters, at most 80 characters
  const cleanSnippet = (s) =>
    typeof s === "string" ? [...s.replace(/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu, " ").replace(/\s+/g, " ").trim()].slice(0, SNIPPET).join("") : "";
  // a reply's quote: { id?, uid?, name?, s, g?, sp? } (g: the quoted line was a GIF; sp (2.2): it had a
  // spoiler, so the quote only says "Spoiler")
  function cleanRe(r) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    const g = r.g === 1 || r.g === true;
    const sp = !g && (r.sp === 1 || r.sp === true);
    const s = g ? "" : sp ? "Spoiler" : cleanSnippet(r.s);
    if (!g && !s) return null;
    return {
      id: MID_RE.test(r.id || "") ? r.id : null,
      uid: typeof r.uid === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(r.uid) ? r.uid : null,
      name: cleanName(r.name) || null,
      s,
      g,
      sp,
    };
  }
  // ---- 2.2: @mentions, spoilers, edits and deletes, all inside the encrypted chat line.
  // A mention { p, i, n }: the "@Name" at text[i, i + n) as it was typed names member p (shown with p's current
  // name). A spoiler { i, n, s }: the "[spoiler]" placeholder at text[i, i + n) stands for the hidden text s, so
  // clients older than 2.2 show "[spoiler]" and never the hidden text. Edits { t: "me", id, text, mn?, sp? } and
  // deletes { t: "md", id } only count when they come from the line's own sender (the pid the ciphertext is
  // bound to); older clients drop both without showing anything.
  const SP_PH = "[spoiler]";
  const PID_RE = /^[a-z0-9]{1,16}$/;
  function cleanMarks(text, p) {
    const out = {};
    const taken = [];
    const free = (i, n) => !taken.some(([a, b]) => i < b && a < i + n);
    if (Array.isArray(p.sp)) {
      const sp = [];
      for (const x of p.sp.slice(0, 10)) {
        if (!x || !Number.isInteger(x.i) || x.i < 0 || x.n !== SP_PH.length || text.substr(x.i, x.n) !== SP_PH || typeof x.s !== "string" || !free(x.i, x.n)) continue;
        const hid = x.s.trim().slice(0, 500);
        if (!hid) continue;
        sp.push({ i: x.i, n: x.n, s: hid });
        taken.push([x.i, x.i + x.n]);
      }
      if (sp.length) out.sp = sp;
    }
    if (Array.isArray(p.mn)) {
      const mn = [];
      for (const x of p.mn.slice(0, 10)) {
        if (!x || !Number.isInteger(x.i) || !Number.isInteger(x.n) || x.i < 0 || x.n < 2 || x.n > 25 || x.i + x.n > text.length || text[x.i] !== "@") continue;
        if (typeof x.p !== "string" || !PID_RE.test(x.p) || !free(x.i, x.n)) continue;
        mn.push({ p: x.p, i: x.i, n: x.n });
        taken.push([x.i, x.i + x.n]);
      }
      if (mn.length) out.mn = mn;
    }
    return out;
  }
  // the text as it was typed (spoilers back between ||…||), to edit it
  const rawText = (text, sp) => {
    let out = "", at = 0;
    for (const x of [...(sp || [])].sort((a, b) => a.i - b.i)) {
      out += text.slice(at, x.i) + "||" + x.s + "||";
      at = x.i + x.n;
    }
    return out + text.slice(at);
  };
  // decrypted chat payload -> { text } or { gif: { url, w, h } } (plus mid / re), a message reaction
  // { mr: { id, e, on } }, or null if it isn't valid. 2.0.x clients only know "text" and "gif" and
  // ignore the extra fields, and drop "mr" lines entirely.
  function cleanChat(p) {
    const extra = () => {
      const x = {};
      if (MID_RE.test(p.mid || "")) x.mid = p.mid;
      const re = cleanRe(p.re);
      if (re) x.re = re;
      return x;
    };
    if (p?.t === "gif") return isKlipyMediaUrl(p.url) ? { gif: { url: p.url, w: dim(p.w), h: dim(p.h) }, ...extra() } : null;
    if (p?.t === "text" && typeof p.text === "string") {
      const text = p.text.trim().slice(0, 500);
      return text ? { text, ...cleanMarks(text, p), ...extra() } : null;
    }
    if (p?.t === "me" && MID_RE.test(p.id || "") && typeof p.text === "string") {
      const text = p.text.trim().slice(0, 500);
      return text ? { me: { id: p.id, text, ...cleanMarks(text, p) } } : null;
    }
    if (p?.t === "md") return MID_RE.test(p.id || "") ? { md: { id: p.id } } : null;
    if (p?.t === "mr") return MID_RE.test(p.id || "") && isSingleEmoji(p.e, 16) && typeof p.on === "boolean" ? { mr: { id: p.id, e: p.e, on: p.on } } : null;
    return null;
  }
  // 2.1 and older read only { name, avatar }: avatar stays an emoji (the HD picture's closest one)
  const cleanProfile = (p) => {
    const hd = cleanHd(p?.hd) || cleanHd(p?.avatar);
    return { name: cleanName(p?.name) || "Guest", avatar: cleanAvatar(p?.avatar) || (hd ? HD.get(hd.slice(3)).emoji : null), hd, img: cleanImg(p?.img) };
  };
  // our own: chrome.storage.sync avatar (an emoji or "av:<slug>") + chrome.storage.local avatarPhoto
  let mineMemo = null;
  function myPic() {
    const k = party.avatar + "|" + (party.photo ? party.photo.length + party.photo.slice(-24) : "");
    if (mineMemo?.k !== k) {
      const hd = cleanHd(party.avatar);
      mineMemo = { k, avatar: hd ? HD.get(hd.slice(3)).emoji : cleanAvatar(party.avatar), hd, img: cleanImg(party.photo) };
    }
    return mineMemo;
  }

  // room keys for this tab (kept by the background in chrome.storage.session)
  const keys = {
    async get(code) {
      const g = window.__netpartyInviteKey;
      if (g && g.code === code && e2e.validKey(g.key)) return g.key;
      const r = await chrome.runtime.sendMessage({ cmd: "roomKey", op: "get", code }).catch(() => null);
      return e2e.validKey(r?.key) ? r.key : null;
    },
    async set(code, key) {
      const r = await chrome.runtime.sendMessage({ cmd: "roomKey", op: "set", code, key }).catch(() => null);
      if (!r?.ok) throw new Error("Couldn't keep the party key in this browser.");
    },
    async del(code) {
      if (window.__netpartyInviteKey?.code === code) window.__netpartyInviteKey = null;
      await chrome.runtime.sendMessage({ cmd: "roomKey", op: "del", code }).catch(() => {});
    },
  };

  // ------------------------------------------- any page: the video and its page (2.0)
  // anyvideo.js finds the video (page, open shadow roots, same-origin iframes), or an agent in a
  // cross-origin iframe drives it. This keeps track of which one is ours, follows the site when it swaps the
  // element (ads, next episode), nudges the speed to correct small drift, and runs Theater mode.
  // The page { u: address, d: duration in s, -1 for a live stream } is what the host shares, encrypted.
  const PAGE_MAX = 2048;
  function safePageUrl(s) {
    if (typeof s !== "string" || !s || s.length > PAGE_MAX || /[\u0000-\u0020\u007f]/.test(s)) return null;
    let u;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.href !== s) return null;
    return u.href;
  }
  const cleanPage = (p) => {
    if (!p || typeof p !== "object") return null;
    const d = p.d === -1 || (Number.isFinite(p.d) && p.d >= 0 && p.d < 1e7) ? p.d : null;
    return { u: safePageUrl(p.u), d };
  };
  const anyV = IS_ANY
    ? (() => {
        const lib = globalThis.__npAnyLib;
        let cur = null; // { v, chain, rect } the <video> we drive (here or in a same-origin iframe)
        let agent = null; // { frameId, origin, el, chain } a video in a cross-origin iframe, driven via the background
        let frameHint = null; // origin of a cross-origin iframe that may hold the video (needs the user's OK)
        let base = 1; // the party's speed
        let nudged = null; // a speed we set to catch up / slow down a little, or null
        let lastDur = NaN; // seconds; Infinity for a live stream
        let lastScan = 0;
        let lastTU = 0;
        let picking = false;
        let pickerShown = false; // asked once on this page already (don't keep popping it up)
        let theater = false;
        let reserved = 0; // px on the right kept for the chat panel
        let changedT = null;
        const EVENTS = ["play", "pause", "seeked", "ratechange", "timeupdate", "durationchange", "loadedmetadata", "emptied"];
        const same = (a, b) => Math.abs(a - b) < 1e-3;
        function onEvt(e) {
          const v = e.currentTarget;
          if (!cur || v !== cur.v) return;
          switch (e.type) {
            case "play":
            case "pause":
            case "seeked":
              onLocalPlayerEvent(e.type);
              break;
            case "ratechange":
              if ((nudged !== null && same(v.playbackRate, nudged)) || same(v.playbackRate, base)) return;
              base = v.playbackRate;
              nudged = null;
              onLocalPlayerEvent("rate");
              break;
            case "timeupdate": {
              const now = Date.now();
              if (now - lastTU < 1000) return;
              lastTU = now;
              if (v.duration === lastDur || (Number.isNaN(v.duration) && Number.isNaN(lastDur))) return;
              lastDur = v.duration;
              changed();
              break;
            }
            default:
              lastDur = v.duration;
              changed();
          }
        }
        // something about the video changed: the host re-shares the page, guests re-check it's the same video
        function changed() {
          clearTimeout(changedT);
          changedT = setTimeout(() => {
            sendPage();
            checkMismatch();
            ui.render();
          }, 400);
        }
        function detach() {
          if (cur) for (const t of EVENTS) cur.v.removeEventListener(t, onEvt);
          cur = null;
        }
        function attach(c) {
          if (cur && c && cur.v === c.v) return;
          detach();
          if (!c) return;
          cur = { v: c.v, chain: c.chain || [], rect: c.rect || lib.topRect(c.v, c.chain) };
          for (const t of EVENTS) cur.v.addEventListener(t, onEvt);
          lastDur = cur.v.duration;
          frameHint = null;
          nudged = null;
          if (theater) applyTheater();
          changed();
          // catch up with the party on the new element
          setTimeout(() => party.roomId && party.state && applyRemote(party.state, "attach"), 300);
          ui.render();
        }
        // non-interactive look at the page: { pick } | { ambiguous: [...] } | { agent } | { frame } | { none }
        function find() {
          const { list, frames } = lib.candidates();
          const r = lib.choose(list);
          if (r.pick) return { pick: r.pick };
          if (r.ambiguous) return { ambiguous: r.ambiguous };
          if (agent) return { agent };
          if (frames.length) {
            frameHint = frames[0].origin;
            return { frame: frames[0] };
          }
          return { none: true };
        }
        // let the user click the video they mean; resolves true once one is attached
        async function pick(list) {
          picking = pickerShown = true;
          try {
            const c = await lib.picker(list);
            if (c) attach(c);
            return !!c;
          } finally {
            picking = false;
          }
        }
        // keep following the right <video>: re-attach when the site replaces it
        function tick() {
          if (!party.roomId || picking) return;
          if (cur && cur.v.isConnected) {
            cur.rect = lib.topRect(cur.v, cur.chain);
            return;
          }
          const now = Date.now();
          if (now - lastScan < 700) return;
          lastScan = now;
          const { list, frames } = lib.candidates();
          if (cur) {
            // swapped (ad, next episode): the new element sitting where the old one was
            const old = cur.rect;
            detach();
            const overlap = (r) => Math.max(0, Math.min(r.right, old.right) - Math.max(r.left, old.left)) * Math.max(0, Math.min(r.bottom, old.bottom) - Math.max(r.top, old.top));
            const best = list.map((c) => [c, overlap(c.rect)]).sort((a, b) => b[1] - a[1])[0];
            if (best && best[1] > 0.3 * Math.min(old.width * old.height, best[0].rect.width * best[0].rect.height)) return attach(best[0]);
          }
          const r = lib.choose(list);
          if (r.pick) return attach(r.pick);
          if (r.ambiguous && !pickerShown) return void pick(r.ambiguous);
          const hint = !r.ambiguous && !agent && frames[0] ? frames[0].origin : null;
          if (hint !== frameHint) {
            frameHint = hint;
            ui.render();
          }
        }
        setInterval(tick, 1000);
        // ---- cross-origin iframe agent (messages relayed by the background)
        const toAgent = (m) => (agent ? chrome.runtime.sendMessage({ cmd: "npAgent", frameId: agent.frameId, ...m }).catch(() => null) : Promise.resolve(null));
        function onFrame(m) {
          if (m.op === "hello") {
            if (cur) return; // a video in this page wins
            if (m.again && agent && agent.frameId === m.frameId) return; // the agent we drive, still there (2.2 heartbeat)
            const f = lib.candidates().frames.find((x) => x.origin === m.origin);
            agent = { frameId: m.frameId, origin: m.origin, el: f?.el || null, chain: f?.chain || [] };
            frameHint = null;
            nudged = null;
            if (theater) applyTheater();
            changed();
            setTimeout(() => party.roomId && party.state && applyRemote(party.state, "attach"), 300);
            ui.render();
            return;
          }
          if (!agent || m.frameId !== agent.frameId || cur) return;
          if (m.op === "lost") return;
          if (m.op !== "event") return;
          if (m.kind === "play" || m.kind === "pause" || m.kind === "seeked") onLocalPlayerEvent(m.kind);
          else if (m.kind === "ratechange" && Number.isFinite(m.rate)) {
            if ((nudged !== null && same(m.rate, nudged)) || same(m.rate, base)) return;
            base = m.rate;
            nudged = null;
            onLocalPlayerEvent("rate");
          } else changed();
        }
        // ---- playback
        async function status() {
          if (cur?.v) {
            const x = cur.v;
            lastDur = x.duration;
            return {
              position: Math.round((x.currentTime || 0) * 1000),
              playing: !x.paused,
              buffering: x.readyState < 3 && !x.paused,
              ready: x.readyState >= 3,
              duration: x.duration === Infinity ? -1 : Math.round((x.duration || 0) * 1000),
              live: x.duration === Infinity,
            };
          }
          if (!agent) return null;
          const r = await toAgent({ op: "status" });
          if (!r || !Number.isFinite(r.position)) return null;
          lastDur = r.live ? Infinity : r.duration > 0 ? r.duration / 1000 : NaN;
          return { position: r.position, playing: !!r.playing, buffering: !!r.buffering, ready: r.ready !== false, duration: r.duration, live: !!r.live };
        }
        async function setRate(r, nudge) {
          if (cur?.v) cur.v.playbackRate = r;
          else await toAgent({ op: "rate", rate: r, nudge });
        }
        return {
          get video() {
            return cur?.v || null;
          },
          get ready() {
            return !!(cur || agent);
          },
          get frameHint() {
            return frameHint;
          },
          get picking() {
            return picking;
          },
          get theater() {
            return theater;
          },
          get base() {
            return base;
          },
          // seconds (Infinity: live); NaN while unknown
          get duration() {
            if (cur?.v) lastDur = cur.v.duration;
            return lastDur;
          },
          get live() {
            return this.duration === Infinity;
          },
          find,
          attach,
          pick,
          tick,
          onFrame,
          changed,
          resetAsk: () => (pickerShown = false),
          status,
          seek: async (ms) => (cur?.v ? (cur.v.currentTime = Math.max(0, ms) / 1000) : toAgent({ op: "seek", position: ms })),
          // 2.2 auto-duck: read or set (0..1) the video's volume
          async volume(v) {
            if (cur?.v) {
              if (Number.isFinite(v)) cur.v.volume = Math.min(1, Math.max(0, v));
              return cur.v.volume;
            }
            const r = await toAgent({ op: "vol", vol: Number.isFinite(v) ? v : undefined });
            return Number.isFinite(r?.vol) ? r.vol : null;
          },
          play: async () => (cur?.v ? cur.v.play()?.catch(() => {}) : toAgent({ op: "play" })),
          pause: async () => (cur?.v ? cur.v.pause() : toAgent({ op: "pause" })),
          // the party's speed (from a remote update); also ends any nudge
          async setBase(r) {
            r = Number.isFinite(r) && r >= 0.0625 && r <= 16 ? r : 1;
            if (same(r, base) && nudged === null) return;
            base = r;
            nudged = null;
            await setRate(r, false);
          },
          // small speed change to close a gap of a few hundred ms (dir +1 = speed up, -1 = slow down, 0 = stop)
          async nudge(dir, gapMs = 0) {
            const k = Math.min(0.1, 0.03 + Math.abs(gapMs) / 20000);
            const want = dir ? Math.round(base * (1 + dir * k) * 1000) / 1000 : null;
            if (want === nudged || (want === null && nudged === null)) return;
            nudged = want;
            await setRate(want ?? base, true);
          },
          get nudged() {
            return nudged;
          },
          // ---- Theater mode: the video (or the iframe holding it) fills the window left of the chat
          setReserved(px) {
            if (px === reserved) return;
            reserved = px;
            if (theater) applyTheater();
          },
          async toggleTheater(on = !theater) {
            theater = !!on;
            if (!theater && document.fullscreenElement === document.documentElement) await document.exitFullscreen().catch(() => {});
            applyTheater();
            ui.render();
          },
        };
        function applyTheater() {
          lib.theaterOff();
          toAgent({ op: "theater", on: theater && !cur });
          if (!theater) return;
          const topFill = { width: `calc(100vw - ${reserved}px)`, height: "100vh" };
          const inner = { width: "100vw", height: "100vh" };
          if (cur) {
            const els = [...cur.chain, cur.v];
            els.forEach((n, i) => lib.theaterOn(n, i === 0 ? topFill : inner));
          } else if (agent?.el) [...agent.chain, agent.el].forEach((n, i) => lib.theaterOn(n, i === 0 ? topFill : inner));
        }
      })()
    : null;

  // the page the host shares with the party (address + duration); host only
  let pageSig = "";
  function pageNow() {
    let u = location.href;
    if (u.length > PAGE_MAX) u = u.split("#")[0];
    const d = anyV.duration;
    return { u: safePageUrl(u), d: d === Infinity ? -1 : Number.isFinite(d) && d > 0 ? Math.round(d * 10) / 10 : null };
  }
  async function sendPage() {
    if (!IS_ANY || !party.roomId || !party.me || party.me !== party.hostId || !e2e.ready) return;
    const p = pageNow();
    const sig = JSON.stringify(p);
    if (sig === pageSig || sig === JSON.stringify(party.page)) return void (pageSig = sig);
    pageSig = sig;
    try {
      const ct = await e2e.seal("page", "", p);
      await net.request("page", { ct });
      party.page = p;
    } catch {
      pageSig = "";
    }
  }
  // guests: is this the host's video? Durations more than 3 s apart (both known, not live) say it isn't
  let anyMismatch = false;
  function checkMismatch() {
    let m = false;
    if (IS_ANY && party.roomId && party.me !== party.hostId && anyV.ready) {
      const hd = party.page?.d, gd = anyV.duration;
      m = Number.isFinite(hd) && hd > 0 && Number.isFinite(gd) && gd > 0 && Math.abs(hd - gd) > 3;
    }
    if (m === anyMismatch) return;
    anyMismatch = m;
    if (m) ui.system("You're on a different video than the host, so sync is paused for you.");
    else if (party.state) applyRemote(party.state, "same-video");
    ui.render();
  }
  // "Open host's page": this tab goes to the host's page (checked: http(s) only). The party key stays in this
  // tab's extension storage, so the popup there offers "Join party on this tab".
  async function openHostPage() {
    const u = safePageUrl(party.page?.u);
    if (!u) return;
    await net.request("leave", {}, 2000).catch(() => {});
    location.href = u;
  }
  // live stream on either side: only play and pause are synced
  const anyLive = () => IS_ANY && (anyV.live || party.page?.d === -1);

  // ------------------------------------------- Crunchyroll's player frame (2.2)
  // The episode plays in an iframe from static.crunchyroll.com. The manifest puts anyvideo.js into that frame
  // (all_frames), where it runs as the same small agent "Sync any video" uses for cross-origin players: it
  // finds the frame's <video> and this script drives it through the extension's background (never through
  // the page's own messaging). If a newer player puts the <video> in the page itself, that one is used.
  const crFrame = (() => {
    let agent = null; // { frameId }
    let ad = false;
    const toAgent = (m) => (agent ? chrome.runtime.sendMessage({ cmd: "npAgent", frameId: agent.frameId, ...m }).catch(() => null) : Promise.resolve(null));
    const topVideo = () => (IS_CR ? largest(shownVideos().filter((v) => v.getBoundingClientRect().width >= 200)) : null);
    // keep the frame's ad flag fresh (sync stops asking the player for its position while an ad shows)
    if (IS_CR) setInterval(() => agent && !topVideo() && api.status(), 1000);
    const api = {
      topVideo,
      get ad() {
        return ad;
      },
      get ready() {
        return !!agent || !!topVideo();
      },
      onFrame(m) {
        if (!IS_CR || m.origin !== "https://static.crunchyroll.com") return;
        if (m.op === "hello") {
          if (agent && agent.frameId === m.frameId) return; // a heartbeat from the frame we already drive
          agent = { frameId: m.frameId };
          ad = false;
          setTimeout(() => party.roomId && party.state && applyRemote(party.state, "attach"), 300);
          return;
        }
        if (!agent || m.frameId !== agent.frameId || topVideo()) return;
        if (m.op === "lost") return void (agent = null);
        if (m.op === "event" && (m.kind === "play" || m.kind === "pause" || m.kind === "seeked")) onLocalPlayerEvent(m.kind);
      },
      async status() {
        const r = await toAgent({ op: "status" });
        if (!r || !Number.isFinite(r.position)) return null;
        ad = !!r.ad;
        return { position: r.position, playing: !!r.playing, buffering: !!r.buffering, ready: r.ready !== false, duration: r.duration };
      },
      seek: (ms) => toAgent({ op: "seek", position: ms }),
      play: () => toAgent({ op: "play" }),
      pause: () => toAgent({ op: "pause" }),
      async volume(v) {
        const r = await toAgent({ op: "vol", vol: Number.isFinite(v) ? v : undefined });
        return Number.isFinite(r?.vol) ? r.vol : null;
      },
    };
    return api;
  })();

  // ------------------------------------------------- page-context bridge
  // status() -> { position (ms), playing, buffering, ready (enough data to play on), duration } or null
  const bridge = (() => {
    if (IS_ANY) return { status: () => anyV.status(), seek: (ms) => anyV.seek(ms), play: () => anyV.play(), pause: () => anyV.pause() };
    // YouTube: a plain HTML5 <video> in #movie_player, driven straight from here. (No page
    // script needed, which matters because youtube.com enforces a nonce-based script-src.)
    // Prime Video: the HTML5 <video> in its overlay player, the same way. HBO Max and SonyLIV (2.2): the
    // biggest <video> on screen. Crunchyroll (2.2): the <video> in the page if there is one, else the
    // player frame's (crFrame).
    if (DIRECT || IS_CR) {
      const v = IS_PRIME
        ? () => primePlayer()?.video || null
        : IS_YT
          ? () => document.querySelector("#movie_player video.html5-main-video") || document.querySelector("#movie_player video") || mainVideo()
          : () => mainVideo();
      const status = () => {
        const x = v();
        if (!x) return IS_CR ? crFrame.status() : null;
        return {
          position: Math.round((x.currentTime || 0) * 1000),
          playing: !x.paused,
          buffering: x.readyState < 3 && !x.paused,
          ready: x.readyState >= 3,
          duration: Math.round((x.duration || 0) * 1000),
        };
      };
      if (IS_CR)
        return {
          status: async () => status(),
          seek: async (ms) => (v() ? (v().currentTime = Math.max(0, ms) / 1000) : crFrame.seek(ms)),
          play: async () => (v() ? await v().play()?.catch(() => {}) : crFrame.play()),
          pause: async () => (v() ? v().pause() : crFrame.pause()),
        };
      return {
        status: async () => status(),
        seek: async (position) => {
          const x = v();
          if (x) x.currentTime = Math.max(0, position) / 1000;
        },
        play: async () => {
          await v()?.play()?.catch(() => {});
        },
        pause: async () => v()?.pause(),
      };
    }
    let seq = 0;
    const pending = new Map();
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("page.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).append(s);
    window.addEventListener("message", (e) => {
      if (e.source !== window || e.data?.source !== TAG || e.data.dir !== "toContent") return;
      const p = pending.get(e.data.id);
      if (p) {
        pending.delete(e.data.id);
        p(e.data.result);
      }
    });
    const call = (kind, payload) =>
      new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        window.postMessage({ source: TAG, dir: "toPage", id, kind, payload }, "*");
        setTimeout(() => pending.has(id) && (pending.delete(id), resolve(null)), 1500);
      });
    return {
      status: () => call("status"),
      seek: (position) => call("act", { action: "seek", position }),
      play: () => call("act", { action: "play" }),
      pause: () => call("act", { action: "pause" }),
    };
  })();

  // ------------------------------------------------------- server socket
  const net = (() => {
    let port = null;
    let reqSeq = 0;
    const pending = new Map();
    const listeners = new Set();
    let open = false;
    let wantOpen = false;
    let retries = 0;
    let url = null;

    // port traffic keeps Chrome from idling out the background worker that holds the socket
    setInterval(() => {
      if (!port || !wantOpen) return;
      try {
        port.postMessage({ cmd: "ping" });
      } catch {
        port = null;
        onLost();
      }
    }, 20000);
    // come back straight away when the network or the tab returns
    const kick = () => {
      if (wantOpen && !open) {
        retries = 0;
        try {
          port ? port.postMessage({ cmd: "open", url }) : connect();
        } catch {
          connect();
        }
      }
    };
    addEventListener("online", kick);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && kick());

    function connect() {
      port = chrome.runtime.connect({ name: "netparty-socket" });
      port.onMessage.addListener((m) => {
        if (m.evt === "open") {
          open = true;
          retries = 0;
          emit({ type: "_open" });
        } else if (m.evt === "message") {
          let msg;
          try {
            msg = JSON.parse(m.data);
          } catch {
            return;
          }
          if (msg.type === "reply") {
            const p = pending.get(msg.reqId);
            if (p) {
              pending.delete(msg.reqId);
              msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.data);
            }
          } else emit(msg);
        } else if (m.evt === "close" || m.evt === "error") {
          if (m.evt === "close") onLost();
        }
      });
      port.onDisconnect.addListener(() => {
        port = null;
        onLost();
      });
      port.postMessage({ cmd: "open", url });
    }

    function onLost() {
      const was = open;
      open = false;
      for (const p of pending.values()) p.reject(new Error("Connection lost"));
      pending.clear();
      if (was) emit({ type: "_closed" });
      if (!wantOpen) return;
      retries++;
      // keep trying for as long as we're in a party; just tell the user once if it drags on
      if (retries === 6) emit({ type: "_failed" });
      const delay = Math.min(10000, 500 * 2 ** Math.min(retries, 5));
      setTimeout(() => {
        if (!wantOpen) return;
        try {
          port ? port.postMessage({ cmd: "open", url }) : connect();
        } catch {
          connect();
        }
      }, delay);
    }

    function emit(msg) {
      for (const fn of listeners) {
        try {
          fn(msg);
        } catch (e) {
          console.error(e);
        }
      }
    }

    return {
      get open() {
        return open;
      },
      start(serverUrl) {
        url = serverUrl;
        wantOpen = true;
        retries = 0;
        if (open) return;
        if (port) port.postMessage({ cmd: "open", url });
        else connect();
      },
      stop() {
        wantOpen = false;
        open = false;
        try {
          port?.postMessage({ cmd: "close" });
          port?.disconnect();
        } catch {}
        port = null;
      },
      request(type, data, timeout = 8000) {
        return new Promise((resolve, reject) => {
          if (!open || !port) return reject(new Error("Not connected"));
          const reqId = ++reqSeq;
          pending.set(reqId, { resolve, reject });
          port.postMessage({ cmd: "send", data: JSON.stringify({ type, reqId, data }) });
          setTimeout(() => pending.has(reqId) && (pending.delete(reqId), reject(new Error("Timed out"))), timeout);
        });
      },
      on(fn) {
        listeners.add(fn);
      },
      waitOpen(ms = 8000) {
        return new Promise((resolve, reject) => {
          if (open) return resolve();
          const t = setTimeout(() => (listeners.delete(fn), reject(new Error("Could not reach the party server"))), ms);
          const fn = (m) => {
            if (m.type === "_open") {
              clearTimeout(t);
              listeners.delete(fn);
              resolve();
            }
          };
          listeners.add(fn);
        });
      },
    };
  })();

  // ------------------------------------------------------------ clock sync
  // serverNow ≈ Date.now() + clock.offset
  const clock = {
    offset: 0,
    rtt: 0,
    async sync(samples = 5) {
      const offs = [], rtts = [];
      for (let i = 0; i < samples; i++) {
        const t0 = Date.now();
        try {
          const { serverTime } = await net.request("time", {}, 3000);
          const t1 = Date.now();
          rtts.push(t1 - t0);
          offs.push(serverTime + (t1 - t0) / 2 - t1);
        } catch {}
        await sleep(60);
      }
      if (offs.length) {
        this.offset = Math.round(median(offs));
        this.rtt = Math.round(median(rtts));
      }
      log("clock offset", this.offset, "rtt", this.rtt);
    },
    toLocal: (serverTs) => serverTs - clock.offset,
    serverNow: () => Date.now() + clock.offset,
  };

  // ----------------------------------------------------------- party state
  const party = {
    roomId: null,
    me: null,
    hostId: null,
    hostOnly: false,
    locked: false, // 2.3: no new people can join (host's setting)
    members: [],
    state: null, // { playing, position, at (server ms), videoId, by, rate? }
    page: null, // any-video parties: the host's page { u, d } (decrypted)
    profiles: new Map(), // pid -> { name, avatar } (decrypted)
    profileCt: new Map(), // pid -> the ciphertext it came from
    name: "Guest",
    avatar: null, // an emoji or "av:<slug>" (2.2)
    photo: null, // 2.2: your own photo (data: WebP / JPEG), kept in chrome.storage.local
    serverUrl: "wss://netparty.tech",
    error: null,
  };
  let suppressUntil = 0;
  let lastEpisodeChange = 0;
  let lastLocalAction = 0;
  let lastLocalEvt = 0; // the viewer's own play / pause / seek, before it's sent
  let videoEl = null;

  // rate: the party's playback speed (any-video parties; everyone else plays at 1x)
  const expectedPosition = (st) =>
    st.position + (st.playing ? Math.max(0, Date.now() - clock.toLocal(st.at)) * (Number.isFinite(st.rate) && st.rate > 0 ? st.rate : 1) : 0);

  async function loadPrefs() {
    const p = await chrome.storage.sync.get(["serverUrl", "name", "avatar", "chatFont", "reactions", "theme", ...PREF_KEYS]);
    for (const k of PREF_KEYS) prefs[k] = p[k] !== false;
    party.serverUrl = p.serverUrl || party.serverUrl;
    party.name = p.name || party.name;
    party.avatar = p.avatar || null;
    party.photo = (await chrome.storage.local.get("avatarPhoto").catch(() => ({}))).avatarPhoto || null;
    ui.setFont(p.chatFont);
    ui.setReactions(p.reactions);
    ui.setTheme(p.theme);
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.avatarPhoto) {
      party.photo = ch.avatarPhoto.newValue || null;
      sendProfile();
      ui.render();
      ui.refreshNames();
    }
    if (area !== "sync") return;
    if (ch.name) {
      party.name = ch.name.newValue || "Guest";
      sendProfile();
      ui.refreshNames();
    }
    if (ch.avatar) {
      party.avatar = ch.avatar.newValue || null;
      sendProfile();
      ui.render();
      ui.refreshNames();
    }
    if (ch.chatFont) ui.setFont(ch.chatFont.newValue);
    if (ch.theme) ui.setTheme(ch.theme.newValue);
    if (ch.reactions) ui.setReactions(ch.reactions.newValue);
    if (ch.serverUrl) party.serverUrl = ch.serverUrl.newValue;
    let pref = false;
    for (const k of PREF_KEYS) if (ch[k]) (prefs[k] = ch[k].newValue !== false), (pref = true);
    if (pref) ui.prefsChanged();
  });

  async function ensureConnected() {
    net.start(party.serverUrl);
    await net.waitOpen();
    await clock.sync();
  }

  // Private reconnect secret for this browser tab (128 random bits): survives reloads and
  // episode changes, so the server gives us our seat (and host role) back instead of treating
  // us as a new person. Only ever sent to the server, which never shows it to anyone; other
  // people see our public member id (party.me) instead.
  const TAB_ID = (() => {
    let id = sessionStorage.getItem("netpartyCid");
    if (!/^[0-9a-f]{32}$/.test(id || "")) {
      id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem("netpartyCid", id);
    }
    return id;
  })();

  // Server messages are handled one at a time, in order (decrypting is asynchronous).
  let inboundQ = Promise.resolve();
  const inbound = (fn) => {
    const p = inboundQ.then(fn);
    inboundQ = p.catch((e) => console.error("[NetParty]", e?.name || e));
    return p;
  };

  // our encrypted { name, avatar, hd?, img? }, sent after every join and whenever it changes
  async function sendProfile() {
    if (!party.roomId || !party.me || !e2e.ready) return;
    const pic = myPic();
    const mine = { name: cleanName(party.name) || "Guest", avatar: pic.avatar, ...(pic.hd ? { hd: pic.hd } : {}), ...(pic.img ? { img: pic.img } : {}) };
    party.profiles.set(party.me, mine);
    for (const p of pic.img ? [mine, { ...mine, img: undefined }] : [mine]) {
      try {
        const ct = await e2e.seal("profile", party.me, p);
        if (ct.length > CT_MAX.profile) continue;
        await net.request("profile", { ct });
        return;
      } catch (e) {
        // a server from before 2.2 refuses a profile with a photo: send it without one
        if (!/Bad profile/.test(String(e?.message || e))) return;
      }
    }
  }
  // the party's info from a peek/join/create reply: is it encrypted, and is our key its key?
  async function verifyParty(info, key) {
    if (!info?.e2ee) throw new Error(info?.roomId && !("kc" in info) ? E2E.OLD_SERVER : E2E.OLD_ROOM);
    if (!(await e2e.checkKey(key, info.kc))) throw new Error(E2E.BAD_KEY);
  }

  async function createParty() {
    // any page: a new random id for the party's video (the page's address goes out encrypted, below)
    const vid = IS_ANY ? "av:" + e2e.genKey().slice(0, 16) : videoIdFromUrl();
    if (IS_ANY && !anyV.ready) throw new Error("No video found on this page.");
    if (!vid)
      throw new Error(
        IS_YT
          ? "Open a YouTube video first, then start the party."
          : IS_PRIME && !primeTitlePath()
            ? "Open the title's own page on Prime Video and press play there, then start the party."
            : `Open a ${SITE_NAME} title and press play first, then start the party.`,
      );
    if (adPlaying()) {
      // start from the video itself, not from wherever the ad is
      notice("The party starts as soon as the ad is over.");
      for (let t = 0; t < 180000 && adPlaying(); t += 500) await sleep(500);
    }
    await ensureConnected();
    const st = (await bridge.status()) || { position: 0, playing: false };
    // a fresh room key, made here; it never leaves this browser except in the invite link
    const key = e2e.genKey();
    await e2e.use(null, key);
    const snap = await net.request("create", {
      e2ee: 1,
      cid: TAB_ID,
      hc: 1, // 2.3: this client has the host controls (the server keeps a lock only while the host can undo it)
      kc: await e2e.makeCheck(),
      videoId: vid,
      playing: st.playing,
      position: st.position,
      at: clock.serverNow(),
      ...(IS_ANY && anyV.base !== 1 ? { rate: anyV.base } : {}),
    });
    try {
      if (!snap?.e2ee || typeof snap.roomId !== "string") throw new Error(E2E.OLD_SERVER);
      e2e.setRoom(snap.roomId);
      await keys.set(snap.roomId, key);
      await inbound(() => onJoined(snap));
      if (IS_ANY) await sendPage();
    } catch (e) {
      net.request("end", {}, 3000).catch(() => {});
      e2e.clear();
      throw e;
    }
    ui.system("Party started. Chat is end-to-end encrypted: share the full invite link with friends.");
    return snap;
  }

  async function joinParty(roomId) {
    const key = await keys.get(roomId);
    if (!key) throw new Error(E2E.NEED_LINK);
    await ensureConnected();
    // which title, and is our key the party's key? (checked before joining, so a wrong
    // link never shows up as a member)
    let info;
    try {
      info = await net.request("peek", { roomId, e2ee: 1 });
      await verifyParty(info, key);
    } catch (e) {
      if (e.message === E2E.BAD_KEY) keys.del(roomId);
      throw e;
    }
    await keys.set(info.roomId, key);
    // a party on a video on some other page can only be joined from that page (any-video mode)
    if (!IS_ANY && isAv(info.videoId)) throw new Error("This party is watching a video on another site. Open the invite link and press Open the video.");
    if (!videoIdFromUrl() || (IS_ANY && !isAv(info.videoId))) {
      // not on a player yet (browse page): go to the party's title; the invite code
      // rides along in the URL (the key stays in this tab's extension storage) and the join happens there
      const url = info.videoId && watchUrl(info.videoId, info.roomId);
      if (!url) throw new Error("The host hasn't opened a title yet.");
      net.stop();
      location.href = url;
      return info;
    }
    await e2e.use(info.roomId, key);
    const snap = await net.request("join", { roomId, e2ee: 1, cid: TAB_ID, hc: 1 });
    try {
      await inbound(() => onJoined(snap, key));
    } catch (e) {
      net.request("leave", {}, 3000).catch(() => {});
      e2e.clear();
      throw e;
    }
    if (!snap.returning) ui.system("You joined the party.");
    // the newest state: a playback update that arrived while joining (2.2: e.g. the party playing on again right
    // after pausing for this member's drop-out) wins over the snapshot's
    await applyRemote(party.roomId === snap.roomId && party.state ? party.state : snap.state, "join");
    // came back after an episode change with voice on: reconnect voice too
    if (sessionStorage.getItem("netpartyVoice")) voice.join().catch(() => {});
    return snap;
  }

  // Leaving: a guest just leaves; the host (or anyone, with end=true, who is host)
  // closes the party for everyone.
  async function leaveParty({ end = false, reason = "" } = {}) {
    const wasHost = !!party.me && party.me === party.hostId;
    await voice.leave().catch(() => {});
    try {
      if (net.open) await net.request(end && wasHost ? "end" : "leave", {}, 3000);
    } catch {}
    resetParty();
    if (reason) notice(reason);
  }

  // ---- 2.3 host controls (the server checks that we're the host)
  const hostCtl = {
    async lock(on) {
      await net.request("lock", { locked: !!on });
      party.locked = !!on;
      ui.render();
    },
    async setHostOnly(on) {
      await net.request("settings", { hostOnly: !!on });
      party.hostOnly = !!on;
      ui.render();
    },
    async remove(pid) {
      await net.request("remove", { id: pid });
    },
    async promote(pid) {
      await net.request("promote", { id: pid });
    },
    // hand the party to someone and leave it: it carries on without us
    async handOver(pid) {
      const who = nameOf(pid);
      await net.request("promote", { id: pid });
      await leaveParty({ end: false, reason: `You left the party. ${who} is the host now.` });
    },
  };
  // a server from before 2.3 doesn't know these messages
  const hostErr = (e) => (/Unknown type/.test(String(e?.message || e)) ? "Your party server doesn't support this yet (it needs an update)." : String(e?.message || e));

  // {recap} false: no recap offer (e.g. you were removed)
  function resetParty({ recap: offer = true } = {}) {
    if (party.roomId) {
      keys.del(party.roomId);
      // 2.3: the QR code window for this party's link (if open) closes, and the background forgets the link
      chrome.runtime.sendMessage({ cmd: "shareQr", op: "close" }).catch(() => {});
      const done = recap.finish(party.roomId);
      if (offer && done) done.then((snap) => snap && recapView.offer(snap));
    }
    party.roomId = null;
    party.me = null;
    party.hostId = null;
    party.locked = false;
    party.members = [];
    party.state = null;
    party.page = null;
    if (IS_ANY) {
      anyV.toggleTheater(false);
      anyV.setBase(1);
      anyMismatch = false;
      pageSig = "";
    }
    party.profiles.clear();
    party.profileCt.clear();
    hold.reset();
    typing.reset();
    e2e.clear();
    net.stop();
    for (const k of ["netpartyRoom", "netpartyVoice", "netpartyPanel", "netpartyVol"]) sessionStorage.removeItem(k);
    ui.hide();
    ui.render();
  }

  // small banner for things that happen when the party panel isn't showing
  let noticeHost = null;
  function notice(text) {
    if (!noticeHost) {
      noticeHost = el("div", { id: "netparty-notice" });
      const sh = noticeHost.attachShadow({ mode: "open" });
      sh.append(
        el("style", {}, `.n{position:fixed;top:18px;left:50%;transform:translate(-50%,-20px);opacity:0;z-index:2147483647;
background:#1b1b22;color:#f3f3f6;border:1px solid #7c5cff;border-radius:12px;padding:10px 16px;
font:600 14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 30px #0008;transition:.25s;pointer-events:none}
.n.s{opacity:1;transform:translate(-50%,0)} b{color:#a48bff}
.n[data-theme=light]{background:#fff;color:#17151f;box-shadow:0 8px 30px #0003} .n[data-theme=light] b{color:#5a3fd6}
@media (prefers-color-scheme: light){.n:not([data-theme=dark]){background:#fff;color:#17151f;box-shadow:0 8px 30px #0003} .n:not([data-theme=dark]) b{color:#5a3fd6}}
@media (prefers-reduced-motion: reduce){.n{transition:none}}`),
        el("div", { class: "n" }),
      );
    }
    const box = noticeHost.shadowRoot.querySelector(".n");
    if (ui.theme) box.dataset.theme = ui.theme;
    else delete box.dataset.theme;
    box.replaceChildren(el("b", {}, "NetParty "), text);
    const fsEl = document.fullscreenElement;
    (fsEl && fsEl.localName !== "video" && fsEl.localName !== "iframe" ? fsEl : document.body).append(noticeHost);
    requestAnimationFrame(() => box.classList.add("s"));
    clearTimeout(notice.t);
    notice.t = setTimeout(() => box.classList.remove("s"), 5000);
  }

  // decrypt the encrypted profiles we don't have yet ([pid, ct] pairs)
  let decryptWarned = false;
  let replaying = false; // true while onJoined decrypts the history (the warning waits for it)
  let seenCt = new Set();
  function cantDecrypt() {
    if (decryptWarned) return;
    decryptWarned = true;
    if (!replaying) ui.system("Can't decrypt some messages — check your invite link. They're hidden.");
  }
  async function absorbProfiles(pairs) {
    let changed = false;
    for (const [pid, ct] of pairs) {
      if (typeof pid !== "string" || typeof ct !== "string" || party.profileCt.get(pid) === ct) continue;
      party.profileCt.set(pid, ct);
      const p = await e2e.open("profile", pid, ct);
      if (!p) {
        cantDecrypt();
        continue;
      }
      if (pid !== party.me) party.profiles.set(pid, cleanProfile(p));
      changed = true;
    }
    return changed;
  }
  // a history entry or live line -> what the UI shows, or null (undecryptable / invalid)
  async function decodeLine(h) {
    // 2.3 adds "removed" (the host took them out) and "host" (they're the host now)
    if (h?.kind === "system" || h?.event) return ["join", "leave", "removed", "host"].includes(h.event) ? { kind: "system", event: h.event, id: String(h.id), ts: h.ts } : null;
    if (typeof h?.from !== "string") return null;
    const p = await e2e.open("chat", h.from, h.ct);
    if (!p) {
      cantDecrypt();
      return null;
    }
    const c = cleanChat(p);
    if (!c) return null;
    if (c.mr) return { kind: "mr", from: h.from, ts: h.ts, ...c.mr };
    if (c.me) return { kind: "me", from: h.from, ts: h.ts, ...c.me };
    if (c.md) return { kind: "md", from: h.from, ts: h.ts, ...c.md };
    return { kind: "chat", id: h.from, ts: h.ts, ...c, mid: c.mid || ctMid(h.ct) };
  }

  // A create/join/rejoin reply: the party, its members and history (decrypted here). Runs in
  // the inbound queue so live messages that follow it are shown after the history.
  // 2.2: the pinned message { id, uid, name?, s, g?, sp? } from its ciphertext (bound to whoever pinned it)
  async function openPin(pin) {
    if (!pin || typeof pin.ct !== "string" || typeof pin.by !== "string") return null;
    const p = await e2e.open("pin", pin.by, pin.ct);
    if (!p || !MID_RE.test(p.id || "")) return null;
    const re = cleanRe(p);
    return re ? { ...re, id: p.id, by: pin.by } : null;
  }
  async function onJoined(snap, key = e2e.keyStr) {
    if (!snap?.e2ee) throw new Error(E2E.OLD_SERVER);
    if (!(await e2e.checkKey(key, snap.kc))) throw new Error(E2E.BAD_KEY);
    party.roomId = snap.roomId;
    party.me = snap.you;
    party.hostId = snap.hostId;
    party.hostOnly = snap.hostOnly;
    party.locked = snap.locked === true;
    party.members = Array.isArray(snap.members) ? snap.members : [];
    party.state = snap.state;
    party.page = null;
    if (IS_ANY && typeof snap.page === "string") party.page = cleanPage(await e2e.open("page", "", snap.page));
    party.error = null;
    decryptWarned = false;
    sessionStorage.setItem("netpartyRoom", snap.roomId);
    replaying = true;
    let lines;
    try {
      await absorbProfiles([...Object.entries(snap.profiles || {}), ...party.members.map((m) => [m.id, m.profile])]);
      const hist = Array.isArray(snap.history) ? snap.history : [];
      seenCt = new Set(hist.map((h) => h?.ct).filter(Boolean));
      lines = (await Promise.all(hist.map(decodeLine))).filter(Boolean);
    } finally {
      replaying = false;
    }
    // 2.3 recap: this party's running totals (kept for this tab across reloads), then what the history adds
    await recap.start(snap.roomId);
    for (const l of lines) recap.line(l, false);
    recap.people();
    ui.loadHistory(lines);
    ui.setPin(await openPin(snap.pin));
    evServer = true;
    if (decryptWarned) ui.system("Can't decrypt some messages — check your invite link. They're hidden.");
    sendProfile();
    // keep the chat open/closed the way it was before a reload
    if (sessionStorage.getItem("netpartyPanel") === "closed") ui.mount();
    else ui.show();
    ui.render();
  }

  // Invite links go to the party server's join page, which tells friends without the
  // extension how to get it and sends everyone else straight to the right title.
  const joinPageBase = () => party.serverUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
  // the room key rides in the #fragment, which browsers never send to any server
  const inviteLink = () => (party.roomId && e2e.keyStr ? `${joinPageBase()}/j/${party.roomId}#k=${e2e.keyStr}` : null);
  const directLink = () =>
    party.roomId && party.state?.videoId ? watchUrl(party.state.videoId, party.roomId) : null;

  const canControl = () => !party.hostOnly || party.me === party.hostId;

  // -------------------------------------------------------- playback sync
  async function applyRemote(st, reason) {
    if (!st) return;
    const vid = videoIdFromUrl();
    if (!vid) return; // not on a watch page (left the title): never pull them back in
    if (IS_ANY) {
      // never navigates anyone: a different video shows "Open host's page" instead (checkMismatch)
      if (anyMismatch || anyV.picking) return;
    } else if (st.videoId && !sameVideo(vid, st.videoId)) {
      // a late update from the old episode right after we switched: ours wins
      if (Date.now() - lastEpisodeChange < 8000) return;
      // different title/episode: follow the party (only to a known title shape on this site's kind)
      const url = watchUrl(st.videoId, party.roomId);
      if (!url) return;
      sessionStorage.setItem("netpartyRoom", party.roomId);
      location.href = url;
      return;
    }
    if (adPlaying()) return; // YouTube ad on screen: catch up when it ends (see adWatch)
    const cur = await bridge.status();
    if (!cur) return; // player not ready yet; watchPlayer() re-applies once it is
    if (adPlaying()) return;
    // 2.2: a newer party state came in while we asked the player (its own apply takes over; this one is stale)
    const stale = () => !!party.state && st !== party.state;
    if (stale()) return;
    suppressUntil = Math.max(suppressUntil, Date.now() + SUPPRESS_MS);
    const target = expectedPosition(st);
    if (IS_ANY) await anyV.setBase(st.rate);
    // live streams: there's no shared timeline, so only play / pause follow the party
    if (!(IS_ANY && anyLive()) && Math.abs(target - cur.position) >= SEEK_THRESHOLD_MS) await bridge.seek(target);
    if (stale()) return;
    if (st.playing && !cur.playing) await bridge.play();
    if (!st.playing && cur.playing) await bridge.pause();
    suppressUntil = Math.max(suppressUntil, Date.now() + SUPPRESS_MS);
    log("applied remote", reason, st);
  }

  let sendTimer = null;
  function onLocalPlayerEvent(kind) {
    if (HAS_ADS) adWatch(); // an ad that just ended: the resume events below are the site's, not ours
    if (!party.roomId || Date.now() < suppressUntil || adPlaying()) return;
    if (IS_ANY && (anyMismatch || (kind === "seeked" && anyLive()))) return;
    lastLocalEvt = Date.now();
    // coalesce bursts (Netflix fires pause+seeked+play when scrubbing)
    clearTimeout(sendTimer);
    sendTimer = setTimeout(async () => {
      if (HAS_ADS) adWatch();
      if (Date.now() < suppressUntil || adPlaying()) return; // an ad started, or a remote action is being applied
      const st = await bridge.status();
      if (!st || !party.roomId || !Number.isFinite(st.position) || !videoIdFromUrl() || adPlaying()) return;
      // 2.2: nothing to tell when the player already matches the party (e.g. the late "seeked" of a seek we made
      // for the party while this video was still loading; it would otherwise read as this viewer's own seek)
      if (kind !== "rate" && party.state && st.playing === party.state.playing && Math.abs(st.position - expectedPosition(party.state)) < 1500) return;
      if (!canControl()) {
        ui.system("Only the host can control playback.");
        return applyRemote(party.state, "revert");
      }
      lastLocalAction = Date.now();
      const state = {
        playing: st.playing,
        position: st.position,
        at: clock.serverNow(),
        videoId: videoIdFromUrl(),
        reason: kind,
        ...(IS_ANY && anyV.base !== 1 ? { rate: anyV.base } : {}),
      };
      // only count it once the server took it (a rejected update must not hide an
      // episode change from the check in watchPlayer)
      net.request("state", state).then(
        () => {
          party.state = state;
          hold.userAction(); // a person decided: nothing waits or resumes on its own
        },
        (e) => ui.system(e.message),
      );
    }, 250);
  }

  // periodic drift correction
  setInterval(async () => {
    if (IS_ANY) return; // see anyDrift
    if (!party.roomId || !party.state || !party.state.playing) return;
    if (Date.now() < suppressUntil || Date.now() - lastLocalAction < 4000 || adPlaying()) return;
    const cur = await bridge.status();
    if (!cur || cur.buffering) return;
    const drift = cur.position - expectedPosition(party.state);
    if (Math.abs(drift) > DRIFT_THRESHOLD_MS) {
      log("drift", drift, "correcting");
      applyRemote(party.state, "drift");
    }
  }, 3000);

  // any page: checked every second. A small gap is closed by playing up to 10% faster or slower for a
  // moment (no visible jump); a big one by seeking. Live streams: play / pause only.
  const NUDGE_FROM_MS = 250;
  const HARD_SEEK_MS = 2500;
  async function anyDrift() {
    if (!party.roomId || !party.state || anyMismatch || anyV.picking || !anyV.ready) return anyV.nudge(0);
    if (Date.now() < suppressUntil || Date.now() - lastLocalAction < 3000 || Date.now() - lastLocalEvt < 3000) return;
    const st = party.state;
    const cur = await bridge.status();
    if (!cur || cur.buffering) return anyV.nudge(0);
    if (st.playing !== cur.playing) {
      // a missed play / pause (a site that ignored it, or an event we never saw)
      applyRemote(st, "drift-state");
      return;
    }
    if (!st.playing || anyLive()) return anyV.nudge(0);
    const drift = cur.position - expectedPosition(st);
    if (Math.abs(drift) > HARD_SEEK_MS) {
      log("drift", drift, "seeking");
      await anyV.nudge(0);
      applyRemote(st, "drift");
    } else if (Math.abs(drift) > NUDGE_FROM_MS) await anyV.nudge(drift > 0 ? -1 : 1, drift);
    else if (Math.abs(drift) < 120) await anyV.nudge(0);
  }
  if (IS_ANY) setInterval(anyDrift, 1000);

  // YouTube / Prime Video ads: while one plays this viewer neither sends nor applies sync; when it
  // ends they jump back to where the party is.
  let adWas = false;
  function adWatch() {
    const ad = !!party.roomId && adPlaying();
    if (ad === adWas) return;
    adWas = ad;
    if (ad) ui.system("Ad playing. You'll catch up with the party when it ends.");
    else if (party.roomId && party.state) {
      // the player fires play/seeked as the video resumes; those are not this viewer's choices
      suppressUntil = Math.max(suppressUntil, Date.now() + 2500);
      setTimeout(() => party.roomId && party.state && applyRemote(party.state, "ad-end"), 400);
    }
    ui.render();
  }
  if (HAS_ADS) setInterval(adWatch, 500);

  // attach to the <video> element and follow the sites' SPA navigation
  let lastVideoId = videoIdFromUrl();
  function watchPlayer() {
    if (IS_ANY) {
      // any page: anyV follows the video; the host re-shares the page when its address changes
      anyV.tick();
      if (party.roomId) {
        sendPage();
        currentTitle();
      }
      ui.mount();
      ui.dockCheck();
      return;
    }
    // episode change first, so a newly attached player syncs to the NEW episode
    const vid = videoIdFromUrl();
    if (vid !== lastVideoId) {
      lastVideoId = vid;
      // we moved to another episode ourselves: take the party with us
      if (vid && party.roomId && party.state && !sameVideo(party.state.videoId, vid) && canControl()) {
        const state = { playing: true, position: 0, at: clock.serverNow(), videoId: vid, reason: "episode" };
        const prev = party.state;
        party.state = state;
        lastEpisodeChange = Date.now();
        net.request("state", state).catch(() => {
          party.state = prev; // retry on the next check
          lastVideoId = null;
        });
        ui.system(IS_YT ? "Moved the party to a new video." : IS_PRIME ? "Moved the party to a new title." : "Moved the party to a new episode.");
      }
    }
    const v = mainVideo();
    if (v && v !== videoEl) {
      videoEl = v;
      for (const evt of ["play", "pause", "seeked"]) v.addEventListener(evt, () => onLocalPlayerEvent(evt));
      v.addEventListener("loadeddata", () => party.roomId && party.state && applyRemote(party.state, "loaded"), { once: true });
      // read party.state when the timer fires, not now (it may change in between)
      if (party.roomId && party.state) setTimeout(() => party.roomId && party.state && applyRemote(party.state, "attach"), 800);
    }
    partyLifecycle(vid);
    if (!party.roomId && (IS_YT ? !!vid : !vid)) startButtons.inject();
    else if ((IS_YT || IS_PRIME) && party.roomId) startButtons.clear();
    if (HAS_ADS) adWatch();
    if (vid) currentTitle();
    ui.mount();
    ui.dockCheck();
  }

  // ---- party lifecycle tied to the watch page
  // * leaving the title (any non-watch page) ends the party if you're the host, or
  //   takes you out of it if you're a guest. Next episode stays on a watch page, so
  //   the party carries on.
  // * a pending invite or "Start a NetParty" request is acted on once a player opens.
  // ride out the site's own route changes (Prime's overlay player swaps its <video> between episodes)
  const LEAVE_GRACE_MS = IS_PRIME ? 6000 : IS_SL || IS_CR ? 4000 : 2500;
  let offWatchSince = 0;
  let busy = false;
  let booted = false; // the boot sequence below decides first (reload / rejoin)
  const takeFlag = (key, maxAgeMs) => {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      v = raw;
    }
    const ts = typeof v === "object" && v ? v.ts : Number(v);
    if (!ts || Date.now() - ts > maxAgeMs) {
      sessionStorage.removeItem(key);
      return null;
    }
    return v;
  };
  async function waitForPlayer(ms = 20000) {
    if (IS_ANY) return true; // joining doesn't wait for the video; anyV attaches it when it shows up
    for (let t = 0; t < ms; t += 500) {
      if (!videoIdFromUrl()) return false;
      if (await bridge.status()) return true;
      await sleep(500);
    }
    return !!(await bridge.status());
  }
  function partyLifecycle(vid) {
    if (busy || !booted) return;
    if (party.roomId) {
      if (vid) {
        offWatchSince = 0;
        // opened someone else's invite while already in a party: switch parties
        const inv = takeFlag("netpartyInvite", 10 * 60 * 1000);
        if (inv) {
          sessionStorage.removeItem("netpartyInvite");
          const code = String(inv.code || inv);
          if (code !== party.roomId) {
            busy = true;
            (async () => {
              try {
                await leaveParty({ end: true });
                await waitForPlayer();
                await joinParty(code);
              } catch (e) {
                resetParty();
                notice("Couldn't join: " + e.message);
              } finally {
                busy = false;
              }
            })();
          }
        }
        return;
      }
      if (!offWatchSince) offWatchSince = Date.now();
      if (Date.now() - offWatchSince < LEAVE_GRACE_MS) return;
      offWatchSince = 0;
      const host = party.me === party.hostId;
      busy = true;
      leaveParty({ end: true, reason: host ? "You left the title, so the party ended." : "You left the party." }).finally(() => (busy = false));
      return;
    }
    if (!vid) return;
    const invite = takeFlag("netpartyInvite", 10 * 60 * 1000);
    const start = !invite && takeFlag("netpartyStart", 2 * 60 * 1000);
    if (!invite && !start) return;
    busy = true;
    (async () => {
      try {
        await waitForPlayer();
        if (invite) {
          sessionStorage.removeItem("netpartyInvite");
          await joinParty(String(invite.code || invite));
        } else {
          sessionStorage.removeItem("netpartyStart");
          await createParty();
          ui.show();
        }
      } catch (e) {
        sessionStorage.removeItem("netpartyRoom");
        notice((invite ? "Couldn't join: " : "Couldn't start the party: ") + e.message);
      } finally {
        busy = false;
      }
    })();
  }

  // ---- "Start a NetParty" buttons on title pages (next to Play / More Info)
  const startButtons = (() => {
    const MARK = "data-netparty-start";
    function makeButton(likeEl, onclick) {
      const cs = getComputedStyle(likeEl);
      const b = el("button", { type: "button", [MARK]: "1", "aria-label": "Start a NetParty", title: "Start a watch party for this title" });
      b.style.cssText = [
        "display:inline-flex", "align-items:center", "justify-content:center", "gap:8px", "white-space:nowrap",
        "border:none", "cursor:pointer", "color:#fff", "flex:0 0 auto",
        "background:linear-gradient(135deg,#7c5cff,#b05cff)", "box-shadow:0 4px 18px #7c5cff55",
        `height:${cs.height}`, `min-height:${cs.height}`, `padding:0 ${Math.max(18, parseFloat(cs.paddingLeft) || 0)}px`,
        `border-radius:${cs.borderRadius}`, `font-family:${cs.fontFamily}`, `font-size:${cs.fontSize}`,
        `font-weight:${Math.max(600, parseInt(cs.fontWeight) || 600)}`, `line-height:${cs.lineHeight}`,
      ].join(";");
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("width", "1.2em");
      icon.setAttribute("height", "1.2em");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "currentColor");
      path.setAttribute("d", "M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1a4.2 4.2 0 0 1 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z");
      icon.append(path);
      b.append(icon, el("span", {}, "Start a NetParty"));
      const go = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        sessionStorage.setItem("netpartyStart", String(Date.now()));
        onclick();
      };
      b.addEventListener("click", go, true);
      for (const t of ["mousedown", "pointerdown", "mouseup", "pointerup"]) b.addEventListener(t, (e) => e.stopPropagation());
      return b;
    }
    const visible = (n) => {
      const r = n.getBoundingClientRect();
      if (r.width < 40 || r.height < 20 || r.bottom < 0 || r.top > innerHeight * 1.5) return false;
      const cs = getComputedStyle(n);
      return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.1;
    };
    // the clickable "face" of a candidate: the inner <button> when it's wrapped in a link
    const face = (n) => (n.matches("a") && n.querySelector("button")) || n;
    const label = (n) => ((n.getAttribute("aria-label") || "") + " " + (n.innerText || n.textContent || "")).trim().replace(/\s+/g, " ");
    // the outermost element that is still "just the play button" (an <a> wrapping a <button>)
    const outer = (n) => {
      const a = n.closest("a");
      return a && a.contains(n) && a.querySelectorAll("button").length <= 1 ? a : n;
    };
    const skip = (n) => n.closest(`[${MARK}], nav`) || /trailer|preview/i.test(label(n));
    function place(play, btn) {
      const host = outer(play);
      const parent = host.parentElement;
      const pcs = parent ? getComputedStyle(parent) : null;
      const row = pcs && /flex/.test(pcs.display) && !pcs.flexDirection.startsWith("column");
      const gap = pcs && pcs.columnGap;
      if (!row || !gap || gap === "normal" || gap === "0px") btn.style.marginLeft = "0.75rem";
      if (pcs && /flex/.test(pcs.display) && pcs.flexDirection.startsWith("column")) {
        btn.style.marginLeft = "0";
        btn.style.marginTop = "0.5rem";
        btn.style.width = face(play).getBoundingClientRect().width + "px";
      }
      host.insertAdjacentElement("afterend", btn);
      host.setAttribute(MARK + "-anchor", "1");
    }
    const already = (play) => {
      const host = outer(play);
      return host.nextElementSibling?.hasAttribute(MARK) || host.parentElement?.querySelector(`:scope > [${MARK}]`);
    };
    function netflix() {
      // Big Play / Resume buttons: home billboard, the More Info pop-up, /title/<id>.
      // Netflix tags them data-uia="play-button" (or similar); fall back to links into
      // /watch/<id> and to buttons labelled Play / Resume.
      const cands = new Set([
        ...document.querySelectorAll('[data-uia*="play-button"], [data-uia*="play-video"], [data-uia="billboard-play"]'),
        ...document.querySelectorAll('a[href*="/watch/"]'),
        ...[...document.querySelectorAll("button")].filter((b) => /^(play|resume|continue|watch)\b/i.test(label(b))),
      ]);
      for (const c of cands) {
        if (skip(c)) continue;
        const f = face(c);
        if (!visible(f)) continue;
        const r = f.getBoundingClientRect();
        if (r.width < 80 || r.height < 28) continue; // round hover play icons, thumbnails
        if (c.matches("a") && !c.querySelector("button") && !/play|resume|watch/i.test(label(c) + (c.getAttribute("data-uia") || ""))) continue; // poster links
        if (already(c)) continue;
        const btn = makeButton(f, () => f.click());
        place(c, btn);
      }
    }
    function hotstar() {
      // the big Watch / Watch Now / Watch First Episode / Resume / Subscribe to Watch button
      const re = /^(watch|play|resume|continue|subscribe to watch|start watching)\b/i;
      const cands = [...document.querySelectorAll('button, a[href*="/watch"], [role=button]')].filter((n) => {
        if (skip(n)) return false;
        const f = face(n);
        if (!visible(f)) return false;
        const r = f.getBoundingClientRect();
        if (r.width < 110 || r.height < 32 || r.top > innerHeight) return false;
        const href = n.closest("a")?.getAttribute("href") || "";
        return re.test(label(f)) || /\/\d{5,}\/watch/.test(href) && f.matches("button");
      });
      // biggest one wins; one per page
      cands.sort((x, y) => {
        const a = face(x).getBoundingClientRect(), b = face(y).getBoundingClientRect();
        return b.width * b.height - a.width * a.height;
      });
      const c = cands[0];
      if (!c || document.querySelector(`[${MARK}]`)) return;
      const f = face(c);
      const btn = makeButton(f, () => {
        const a = c.closest("a");
        if (a && /\/watch/.test(a.getAttribute("href") || "")) {
          const u = new URL(a.href, location.href);
          u.searchParams.set("npStart", "1");
          location.href = u.toString();
        } else f.click(); // site navigates itself; the sessionStorage flag rides along
      });
      place(c, btn);
    }
    function prime() {
      // the title page's big Play / Resume / Watch now button (opens the overlay player). Only on a
      // title's own page: that's where the party gets its title id.
      if (!primeTitlePath() || document.querySelector(`[${MARK}]`)) return;
      const re = /^(play|resume|continue|watch|start watching)\b/i;
      const cands = [
        ...new Set([
          ...document.querySelectorAll('[data-automation-id*="play"], [data-testid*="play"], a[href*="autoplay=1"]'),
          ...[...document.querySelectorAll("button, a, [role=button]")].filter((n) => re.test(label(n))),
        ]),
      ].filter((n) => {
        if (skip(n) || n.closest(PRIME_PLAYER.join(","))) return false;
        const f = face(n);
        if (!visible(f)) return false;
        const r = f.getBoundingClientRect();
        if (r.width < 80 || r.height < 28 || r.top > innerHeight) return false;
        return re.test(label(f)) || /play/i.test((n.getAttribute("data-automation-id") || "") + (n.getAttribute("data-testid") || ""));
      });
      cands.sort((x, y) => {
        const a = face(x).getBoundingClientRect(), b = face(y).getBoundingClientRect();
        return b.width * b.height - a.width * a.height;
      });
      const c = cands[0];
      if (!c) return;
      const f = face(c);
      place(c, makeButton(f, () => f.click())); // the player opens on this page; the start flag rides along
    }
    function youtube() {
      // already on the watch page: the button sits in the actions row under the video
      // (before Like/Share) and starts the party right away
      if (!videoIdFromUrl() || document.querySelector(`[${MARK}]`)) return;
      const row = [...document.querySelectorAll("ytd-watch-metadata #top-level-buttons-computed, #above-the-fold #top-level-buttons-computed, #top-level-buttons-computed")].find(
        (n) => n.getBoundingClientRect().width > 0,
      );
      if (!row) return;
      const like = [...row.querySelectorAll("button")].find((b) => visible(b)) || row;
      const btn = makeButton(like, () => setTimeout(watchPlayer, 0));
      const gap = parseFloat(getComputedStyle(row).columnGap);
      if (!(gap > 0)) btn.style.marginRight = "8px"; // the row has no gap of its own
      if (parseFloat(getComputedStyle(like).borderRadius) < 4) btn.style.borderRadius = "18px";
      row.prepend(btn);
    }
    return {
      inject() {
        // 2.2 services (HBO Max, Crunchyroll, SonyLIV): no buttons on their pages yet; the popup starts parties there
        if (IS_HBO || IS_CR || IS_SL) return;
        try {
          IS_YT ? youtube() : IS_PRIME ? prime() : IS_HOTSTAR ? hotstar() : netflix();
        } catch (e) {
          console.warn("[NetParty] start button", e);
        }
      },
      clear() {
        for (const n of document.querySelectorAll(`[${MARK}]`)) n.remove();
      },
    };
  })();

  let watchQueued = false;
  new MutationObserver(() => {
    if (watchQueued) return;
    watchQueued = true;
    setTimeout(() => {
      watchQueued = false;
      watchPlayer();
    }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(watchPlayer, 2000);
  // YouTube's SPA announces each finished navigation (another video, autoplay, back to home)
  if (IS_YT) document.addEventListener("yt-navigate-finish", () => setTimeout(watchPlayer, 50));

  // ---------------------------------------------------- server messages
  // display name for a public member id (from that member's decrypted profile)
  const nameOf = (pid) => (pid && pid === party.me ? cleanName(party.name) || "Guest" : party.profiles.get(pid)?.name || "Someone");
  net.on((msg) => {
    inbound(() => onServer(msg));
  });
  async function onServer(msg) {
    switch (msg.type) {
      case "state":
        party.state = msg.data;
        if (msg.data.reason && msg.data.by) {
          const what = { play: "played", pause: "paused", seeked: "jumped to " + fmt(msg.data.position), episode: IS_YT ? "changed the video" : IS_PRIME ? "changed the title" : "changed the episode", rate: "set the speed to " + (Number.isFinite(msg.data.rate) ? msg.data.rate : 1) + "x" }[msg.data.reason];
          if (what) ui.system(`${nameOf(msg.data.by)} ${what}`);
        }
        applyRemote(msg.data, "remote");
        hold.onState(msg.data);
        break;
      case "page": {
        // any-video parties: the host's page changed (address or video)
        if (!IS_ANY || !party.roomId || typeof msg.data?.ct !== "string") break;
        const p = cleanPage(await e2e.open("page", "", msg.data.ct));
        if (!p) break;
        party.page = p;
        checkMismatch();
        ui.render();
        break;
      }
      case "members":
        if (!party.roomId || !Array.isArray(msg.data.members)) break;
        party.members = msg.data.members;
        party.hostId = msg.data.hostId;
        if (await absorbProfiles(party.members.map((m) => [m.id, m.profile]))) ui.refreshNames();
        recap.people();
        ui.render();
        hold.onMembers();
        break;
      case "settings":
        party.hostOnly = msg.data.hostOnly;
        // 2.3: a server from before 2.3 doesn't send "locked" (and can't lock)
        if ("locked" in msg.data) party.locked = msg.data.locked === true;
        ui.render();
        break;
      case "removed": {
        // 2.3: the host took us out of the party (the server already has; our tab can't rejoin it)
        if (!party.roomId) break;
        await voice.leave().catch(() => {});
        resetParty({ recap: false });
        notice("The host removed you from the party.");
        break;
      }
      case "chat": {
        if (!party.roomId) break;
        const line = await decodeLine(msg.data);
        // the same ciphertext twice (a replay) is shown once
        if (line && !seenCt.has(msg.data.ct)) {
          seenCt.add(msg.data.ct);
          recap.line(line, true);
          if (line.kind === "mr") ui.msgReact(line);
          else if (line.kind === "me") ui.msgEdit(line);
          else if (line.kind === "md") ui.msgDelete(line);
          else {
            typing.heard(line.id); // their line is here: they stopped typing
            ui.chat(line);
          }
        }
        break;
      }
      case "ev": {
        // 2.2 ephemeral signal: typing, my video is loading, the party is waiting
        if (!party.roomId || typeof msg.data?.from !== "string" || !memberHere(msg.data.from)) break;
        const p = await e2e.open("ev", msg.data.from, msg.data.ct);
        if (!p || typeof p.t !== "string") break;
        if (p.t === "ty") typing.got(msg.data.from);
        else if (p.t === "buf" || p.t === "wait") hold.onEv(msg.data.from, { t: p.t, on: p.on === 1 || p.on === true, ids: p.ids, why: typeof p.why === "string" ? p.why : "" });
        break;
      }
      case "pin": {
        // 2.2: the pinned message changed (null: unpinned)
        if (!party.roomId) break;
        ui.setPin(await openPin(msg.data));
        break;
      }
      case "react": {
        if (!party.roomId || typeof msg.data.from !== "string") break;
        const p = await e2e.open("react", msg.data.from, msg.data.ct);
        if (p && isSingleEmoji(p.e, 16)) {
          ui.float(p.e);
          recap.react(p.e);
        }
        break;
      }
      case "ended": {
        const who = nameOf(msg.data.by);
        await voice.leave().catch(() => {});
        resetParty();
        notice(`${who} ended the party.`);
        break;
      }
      case "system": {
        if (!party.roomId) break;
        const line = await decodeLine(msg.data);
        if (line) ui.sysEvent(line.event, line.id);
        break;
      }
      case "voice":
        voice.onVoiceEvent(msg.data);
        break;
      case "signal":
        await voice.onSignal(msg.data.from, msg.data.ct);
        break;
      case "_closed":
        if (party.roomId) ui.system("Connection lost. Reconnecting…");
        break;
      case "_open":
        // reconnect: rejoin the same party with a fresh socket (our cid gets our seat back)
        if (party.roomId && party.me) {
          const room = party.roomId;
          try {
            await clock.sync(3);
            const snap = await net.request("join", { roomId: room, e2ee: 1, cid: TAB_ID, hc: 1 });
            await onJoined(snap); // already in the inbound queue
            ui.system("Reconnected.");
            applyRemote(snap.state, "rejoin");
            if (voice.active) voice.rejoin().catch(() => {});
          } catch (e) {
            if (/not found|ended/i.test(e.message)) {
              await voice.leave().catch(() => {});
              resetParty();
              notice("That party has ended.");
            } else if (/removed you|is locked/i.test(e.message)) {
              // 2.3: the host removed this tab (or locked the party and our seat is gone). Mic and camera off first:
              // the panel goes away with the party, and with it the buttons to turn them off.
              await voice.leave().catch(() => {});
              resetParty({ recap: !/removed you/i.test(e.message) });
              notice(e.message);
            } else ui.system("Couldn't rejoin: " + e.message);
          }
        }
        break;
      case "_failed":
        ui.system("Still reconnecting… (check your internet)");
        break;
    }
  }

  // --------------------------------------------------------- voice + video chat
  // A WebRTC mesh between everyone in voice: audio, plus an optional camera (1.8). Connection
  // setup (SDP, ICE) goes through the server end-to-end encrypted, media flows peer to peer
  // (DTLS-SRTP), or through the Cloudflare TURN relay when the two networks can't reach each other
  // (symmetric NAT, strict campus Wi-Fi). Relay credentials come from voiceJoin / voiceIce and are
  // valid >= 12h from when we got them (server mints 24h, caches 12h); ICE_MAX_AGE refreshes earlier.
  //
  // Video: whoever starts a connection offers a video slot next to the audio (sendrecv, no track
  // yet), so turning the camera on later only puts a track into that slot (replaceTrack): no
  // renegotiation, no offer glare, and 1.7 peers (which don't know about video) keep working.
  // Each 1.8 peer says whether its camera is on in an encrypted signal ({ cam: 1 | 0 }) once the
  // link is up and on every change; that message is also how we know a peer can show video, so
  // a 1.7 peer is never sent any.
  const CAM = {
    MAX: 4, // cameras on at once in a party (each one is sent to every other viewer in voice)
    constraints: { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { ideal: 20, max: 24 }, facingMode: "user" },
    fallback: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20 } },
  };
  // bitrate / size per outgoing copy: the more people we send to, the smaller each copy
  const camEncoding = (n) =>
    n <= 1 ? { maxBitrate: 800_000, maxFramerate: 24, scaleResolutionDownBy: 1 } : n === 2 ? { maxBitrate: 500_000, maxFramerate: 20, scaleResolutionDownBy: 1 } : { maxBitrate: 300_000, maxFramerate: 15, scaleResolutionDownBy: 1.5 };
  const voice = (() => {
    let localStream = null;
    let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    let iceAt = 0; // when iceServers came from the server (0 = never)
    const ICE_MAX_AGE = 6 * 3600 * 1000; // creds are good for >= 12h after we receive them
    const setIce = (list) => {
      if (Array.isArray(list) && list.length) {
        iceServers = list;
        iceAt = Date.now();
      }
    };
    // fresh relay credentials before building a connection that may need the relay; `force` on a
    // reconnect after a failure (the old ones may be what expired)
    async function freshIce(force) {
      if (!force && iceAt && Date.now() - iceAt < ICE_MAX_AGE) return;
      try {
        const r = await net.request("voiceIce", {});
        setIce(r?.iceServers);
      } catch {}
    }
    // id -> { pc, audio, pendingIce: [], sendQ, vt (video transceiver), video (their camera track),
    //        camOn (their camera is on), v18 (they run 1.8+: sent us a cam message or offered video) }
    const peers = new Map();
    const peerState = new Map(); // id -> { muted, speaking }
    const rxQ = new Map(); // id -> chain of incoming signals being handled
    const retries = new Map(); // id -> reconnect attempts since the link last worked
    let muted = false;
    let speaking = false;
    let meter = null;
    let volume = 1;
    // 2.3: each friend's own volume (0..1, on top of the friends' volume slider), by member id. Kept for this
    // tab and party in sessionStorage "netpartyVol" ({ r: party code, v: { pid: volume } }), so reloads keep it.
    const peerVol = new Map();
    let peerVolRoom = null;
    function loadPeerVol() {
      if (peerVolRoom === party.roomId) return;
      peerVolRoom = party.roomId;
      peerVol.clear();
      try {
        const s = JSON.parse(sessionStorage.getItem("netpartyVol") || "null");
        if (s && s.r === party.roomId && s.v && typeof s.v === "object")
          for (const [id, v] of Object.entries(s.v)) if (PID_RE.test(id) && Number.isFinite(v) && v >= 0 && v <= 1) peerVol.set(id, v);
      } catch {}
    }
    const pv = (id) => (loadPeerVol(), peerVol.has(id) ? peerVol.get(id) : 1);
    const effective = (id) => Math.max(0, Math.min(1, volume * pv(id)));
    let active = false;
    let camTrack = null; // our camera, while it's on
    let camBusy = false;

    async function getMic() {
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    }

    const videoSlot = (pc) => pc.getTransceivers().find((t) => t.receiver?.track?.kind === "video" && !t.stopped) || null;
    const canSend = (p) => !!(p.vt && p.v18);
    function tuneVideo() {
      const sending = [...peers.values()].filter(canSend);
      const enc = camEncoding(sending.length);
      for (const p of sending) {
        try {
          const params = p.vt.sender.getParameters();
          if (!params.encodings?.length) continue; // not negotiated yet; tuned again once connected
          Object.assign(params.encodings[0], enc);
          p.vt.sender.setParameters(params).catch(() => {});
        } catch {}
      }
    }

    function makePeer(id, offerer) {
      const pc = new RTCPeerConnection({ iceServers });
      // which relay credentials this link uses (the username's last 4 characters only; e2e checks it)
      log("peer", offerer ? "call" : "answer", "relay", iceServers.filter((s) => s.username).map((s) => String(s.username).slice(-4)).join(",") || "none");
      const audio = new Audio();
      audio.autoplay = true;
      audio.volume = effective(id);
      const entry = { pc, audio, pendingIce: [], sendQ: Promise.resolve(), vt: null, video: null, camOn: false, v18: false };
      peers.set(id, entry);
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      // the video slot rides in the same stream as the mic, so a 1.7 peer's player keeps the audio
      if (offerer) entry.vt = pc.addTransceiver("video", { direction: "sendrecv", streams: [localStream] });
      pc.ontrack = (e) => {
        if (e.track.kind === "video") {
          entry.video = e.track;
          e.track.onmute = e.track.onunmute = e.track.onended = () => ui.cams();
          ui.cams();
          return;
        }
        audio.srcObject = e.streams[0] || new MediaStream([e.track]);
        audio.play().catch(() => ui.system("Click anywhere on the page to hear voice chat."));
      };
      pc.onicecandidate = (e) => e.candidate && signal(entry, id, { ice: e.candidate.toJSON() }).catch(() => {});
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" && peers.get(id) === entry) {
          // the caller retries with fresh relay credentials (twice); the other side waits for its new offer
          const n = (retries.get(id) || 0) + 1;
          retries.set(id, n);
          if (n > 2) ui.system("Couldn't connect voice/video with " + nameOf(id) + ". Ask them to leave and rejoin voice chat.");
          else if (offerer) {
            ui.system("Voice/video link to " + nameOf(id) + " dropped. Reconnecting…");
            setTimeout(async () => {
              if (!active || peers.get(id) !== entry) return;
              await freshIce(true);
              if (!active || peers.get(id) !== entry) return;
              closePeer(id);
              callPeer(id).catch((e) => log("recall failed", e));
            }, 1000 * n);
          }
        }
        if (pc.connectionState === "connected") {
          retries.delete(id);
          tuneVideo();
          // tell them whether our camera is on (also covers a reconnect); 1.7 ignores this
          signal(entry, id, { cam: camTrack ? 1 : 0 }).catch(() => {});
        }
        ui.render();
        ui.cams();
      };
      return entry;
    }

    function closePeer(id) {
      const p = peers.get(id);
      if (!p) return;
      try {
        p.pc.close();
      } catch {}
      p.audio.srcObject = null;
      peers.delete(id);
      peerState.delete(id);
      tuneVideo();
      ui.cams();
    }

    // WebRTC setup (SDP and ICE candidates, which contain IP addresses) is encrypted with the
    // room key too, so the server only relays it. Sent one after another, in order, per peer.
    function signal(entry, to, payload) {
      const run = async () => {
        const ct = await e2e.seal("signal>" + to, party.me, payload);
        if (ct.length > CT_MAX.signal) throw new Error("signal too big");
        await net.request("signal", { to, ct });
      };
      const p = entry.sendQ.then(run);
      entry.sendQ = p.catch(() => {});
      return p;
    }

    async function callPeer(id) {
      await freshIce(false);
      if (!active) return;
      const entry = makePeer(id, true);
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      await signal(entry, id, { sdp: entry.pc.localDescription.toJSON() });
    }

    function startMeter() {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(localStream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let quietSince = 0;
      const iv = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const b of buf) sum += ((b - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        let next = speaking;
        if (!muted && rms > 0.04) {
          next = true;
          quietSince = now;
        } else if (now - quietSince > 400) next = false;
        if (next !== speaking) {
          speaking = next;
          net.request("voiceState", { muted, speaking }).catch(() => {});
          ui.render();
        }
      }, 100);
      meter = { ctx, iv };
    }

    function camError(e) {
      const n = e?.name || "";
      if (n === "NotAllowedError" || n === "SecurityError")
        return `Camera blocked. Allow camera access for ${location.hostname} (the icon at the left of the address bar), then try again.`;
      if (n === "NotFoundError" || n === "OverconstrainedError") return "No camera found on this computer.";
      if (n === "NotReadableError" || n === "AbortError") return "Your camera is in use by another app (or couldn't start). Close that app and try again.";
      return "Couldn't start the camera" + (n ? ` (${n})` : "") + ".";
    }
    const remoteCams = () => [...peers.values()].filter((p) => p.camOn).length;

    async function cameraOn() {
      if (!active || camTrack || camBusy) return;
      if (remoteCams() >= CAM.MAX) {
        ui.system(`${CAM.MAX} cameras are already on, the most a peer-to-peer call handles well. Ask someone to turn theirs off first.`);
        return;
      }
      camBusy = true;
      ui.render();
      let track = null;
      try {
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: CAM.constraints, audio: false });
        } catch (e) {
          if (e?.name !== "OverconstrainedError") throw e;
          stream = await navigator.mediaDevices.getUserMedia({ video: CAM.fallback, audio: false });
        }
        track = stream.getVideoTracks()[0];
        if (!track) throw Object.assign(new Error("no track"), { name: "NotFoundError" });
      } catch (e) {
        camBusy = false;
        ui.system(camError(e));
        ui.render();
        return;
      }
      camBusy = false;
      // left voice (or turned it on twice) while the permission prompt was up
      if (!active || camTrack) {
        track.stop();
        ui.render();
        return;
      }
      track.contentHint = "motion";
      camTrack = track;
      // unplugged, or permission taken away mid-call
      track.addEventListener("ended", () => camTrack === track && cameraOff());
      let reached = 0, old = 0;
      for (const [id, p] of peers) {
        signal(p, id, { cam: 1 }).catch(() => {});
        if (canSend(p)) {
          reached++;
          p.vt.sender.replaceTrack(track).catch(() => {});
        } else if (p.pc.connectionState === "connected") old++;
      }
      tuneVideo();
      if (old && !reached) ui.system("Your friends' NetParty is too old to show video. They can update to 1.8 at netparty.tech.");
      else if (old) ui.system(`${old === 1 ? "One friend's" : old + " friends'"} NetParty is too old to show video (1.8 needed).`);
      ui.render();
      ui.cams();
    }
    function cameraOff() {
      const track = camTrack;
      camTrack = null;
      if (track) track.stop(); // the camera light goes off
      for (const [id, p] of peers) {
        if (p.vt) p.vt.sender.replaceTrack(null).catch(() => {});
        if (track) signal(p, id, { cam: 0 }).catch(() => {});
      }
      ui.render();
      ui.cams();
    }

    const api = {
      get active() {
        return active;
      },
      get muted() {
        return muted;
      },
      get speaking() {
        return speaking;
      },
      get volume() {
        return volume;
      },
      get camOn() {
        return !!camTrack;
      },
      get camBusy() {
        return camBusy;
      },
      get camTrack() {
        return camTrack;
      },
      // remote cameras to show: [{ id, track, live }] (live: frames are arriving)
      cams() {
        const out = [];
        for (const [id, p] of peers) if (p.camOn && p.video && p.video.readyState !== "ended") out.push({ id, track: p.video, live: !p.video.muted && p.pc.connectionState === "connected" });
        return out;
      },
      peerInfo: (id) => ({ ...(peerState.get(id) || {}), connected: peers.get(id)?.pc.connectionState === "connected", cam: !!peers.get(id)?.camOn }),
      async join() {
        if (active || !party.roomId) return;
        try {
          localStream = await getMic();
        } catch (e) {
          ui.system(`Microphone blocked. Allow mic access for ${location.hostname} in the address bar, then try again.`);
          return;
        }
        active = true;
        muted = false;
        sessionStorage.setItem("netpartyVoice", "1");
        startMeter();
        const res = await net.request("voiceJoin", {});
        setIce(res.iceServers);
        // newcomer calls everyone already in voice (one side offers, so no glare)
        for (const id of res.peers) callPeer(id).catch((e) => log("call failed", e));
        ui.system("You joined voice chat. Headphones avoid echo.");
        ui.render();
      },
      async rejoin() {
        for (const id of [...peers.keys()]) closePeer(id);
        const res = await net.request("voiceJoin", {});
        setIce(res.iceServers); // was ignored: after a socket reconnect we kept the old credentials
        for (const id of res.peers) callPeer(id).catch(() => {});
      },
      async leave() {
        sessionStorage.removeItem("netpartyVoice");
        if (!active) return;
        active = false;
        duck.restore(); // the video's volume back to exactly yours
        cameraOff();
        for (const id of [...peers.keys()]) closePeer(id);
        localStream?.getTracks().forEach((t) => t.stop());
        localStream = null;
        if (meter) {
          clearInterval(meter.iv);
          meter.ctx.close();
          meter = null;
        }
        speaking = false;
        try {
          await net.request("voiceLeave", {});
        } catch {}
        ui.render();
        ui.cams();
      },
      toggleMute() {
        if (!active) return;
        muted = !muted;
        localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
        if (muted) speaking = false;
        net.request("voiceState", { muted, speaking }).catch(() => {});
        ui.render();
      },
      toggleCamera() {
        return camTrack ? cameraOff() : cameraOn();
      },
      setVolume(v) {
        volume = v;
        for (const [id, p] of peers) p.audio.volume = effective(id);
      },
      // 2.3: one friend's volume (0..1), applied right away and kept for this tab's party
      peerVolume: (id) => pv(id),
      setPeerVolume(id, v) {
        if (!PID_RE.test(String(id)) || !Number.isFinite(v)) return;
        loadPeerVol();
        const x = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
        if (x === 1) peerVol.delete(id);
        else peerVol.set(id, x);
        try {
          sessionStorage.setItem("netpartyVol", JSON.stringify({ r: party.roomId, v: Object.fromEntries(peerVol) }));
        } catch {}
        const p = peers.get(id);
        if (p) p.audio.volume = effective(id);
      },
      // what each friend's voice plays at right now (the popup's status, and tests)
      levels() {
        const out = {};
        for (const [id, p] of peers) out[id] = Math.round(p.audio.volume * 100) / 100;
        return out;
      },
      onVoiceEvent(d) {
        if (d.event === "join") {
          ui.system(`${nameOf(d.id)} joined voice`);
          peerState.set(d.id, { muted: false, speaking: false });
        } else if (d.event === "leave") {
          closePeer(d.id);
          peerState.delete(d.id);
        } else if (d.event === "state") {
          peerState.set(d.id, { muted: d.muted, speaking: d.speaking });
        }
        ui.render();
      },
      // decrypted in the inbound queue (keeps their order), then handled per peer without
      // holding up chat
      async onSignal(from, ct) {
        if (!active || typeof from !== "string") return;
        const payload = await e2e.open("signal>" + party.me, from, ct);
        if (!payload || !active) return;
        const p = (rxQ.get(from) || Promise.resolve()).then(() => handleSignal(from, payload)).catch((e) => log("signal", e?.name));
        rxQ.set(from, p);
        p.finally(() => rxQ.get(from) === p && rxQ.delete(from));
      },
    };
    async function handleSignal(from, payload) {
      if (!active) return;
      let entry = peers.get(from);
      if (payload.sdp && typeof payload.sdp === "object") {
        const sdp = { type: payload.sdp.type, sdp: String(payload.sdp.sdp || "") };
        if (sdp.type === "offer") {
          // a second offer from the same peer is their reconnect after a failure: the answering side
          // needs fresh relay credentials too, or a relay-only link fails again on our expired ones
          // (runs inside this peer's rxQ chain, so later ICE candidates still wait for us)
          const reconnect = !!entry;
          if (entry) closePeer(from);
          await freshIce(reconnect);
          if (!active) return;
          entry = makePeer(from, false);
          await entry.pc.setRemoteDescription(sdp);
          // a 1.8 caller offered a video slot: answer it as two-way (1.7 callers don't offer one)
          const vt = videoSlot(entry.pc);
          if (vt) {
            vt.direction = "sendrecv";
            entry.vt = vt;
            entry.v18 = true;
            if (camTrack) await vt.sender.replaceTrack(camTrack).catch(() => {});
          }
          const answer = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(answer);
          await signal(entry, from, { sdp: entry.pc.localDescription.toJSON() });
        } else if (sdp.type === "answer" && entry) {
          await entry.pc.setRemoteDescription(sdp);
        }
        for (const c of entry?.pendingIce.splice(0) || []) await entry.pc.addIceCandidate(c).catch(() => {});
      } else if (payload.ice) {
        if (!entry || !entry.pc.remoteDescription) {
          if (!entry) return;
          entry.pendingIce.push(payload.ice);
        } else await entry.pc.addIceCandidate(payload.ice).catch(() => {});
      } else if ("cam" in payload && entry) {
        const first = !entry.v18;
        entry.v18 = true;
        entry.camOn = payload.cam === 1;
        // first word from a 1.8 peer we called: now it's safe to send them our camera
        if (first && camTrack && entry.vt) {
          await entry.vt.sender.replaceTrack(camTrack).catch(() => {});
          tuneVideo();
        }
        ui.cams();
        ui.render();
      }
    }
    return api;
  })();

  // ------------------------------------------------ 2.2: settings, signals, waiting
  // Party and voice settings from the popup or the panel (storage.sync; on unless switched off).
  const prefs = { syncWait: true, dropPause: true, autoDuck: true };
  const PREF_KEYS = Object.keys(prefs);

  // Ephemeral signals: encrypted like everything else (AAD kind "ev", bound to the sender), relayed by the
  // server to the other members and never stored. { t: "ty" } I'm typing; { t: "buf", on } my video is
  // (no longer) stuck loading; { t: "wait", on, ids, why? } the party is waiting for these members.
  const CT_EV = ctChars(pad64(1024));
  let evServer = true; // false once the server says it doesn't know signals (a server older than 2.2)
  async function sendEv(obj) {
    if (!evServer || !party.roomId || !party.me || !e2e.ready || !net.open) return false;
    try {
      const ct = await e2e.seal("ev", party.me, obj);
      if (ct.length > CT_EV) return false;
      await net.request("ev", { ct });
      return true;
    } catch (e) {
      if (/Unknown type/.test(e?.message || "")) evServer = false;
      return false;
    }
  }
  const memberHere = (pid) => party.members.some((m) => m.id === pid);
  const cleanIds = (ids) => (Array.isArray(ids) ? [...new Set(ids.filter((x) => typeof x === "string" && PID_RE.test(x)))].slice(0, 50) : []);

  // ---- typing indicator: sent at most every 3 s while typing, shown for 5 s after the last one
  const typing = (() => {
    const who = new Map(); // pid -> last "typing" time
    let lastSent = 0;
    let timer = 0;
    const live = () => {
      const now = Date.now();
      for (const [pid, t] of who) if (now - t > 5000 || !memberHere(pid)) who.delete(pid);
      return [...who.keys()];
    };
    const redraw = () => {
      clearTimeout(timer);
      ui.typing(live());
      if (who.size) timer = setTimeout(redraw, 1000);
    };
    return {
      // the chat box changed: tell the others (throttled)
      ping() {
        const now = Date.now();
        if (now - lastSent < 3000) return;
        lastSent = now;
        sendEv({ t: "ty" });
      },
      sent: () => (lastSent = 0), // after sending a line, the next keystroke says "typing" again
      got(pid) {
        if (pid === party.me || !memberHere(pid)) return;
        who.set(pid, Date.now());
        redraw();
      },
      heard(pid) {
        if (who.delete(pid)) redraw();
      },
      reset() {
        who.clear();
        lastSent = 0;
        redraw();
      },
    };
  })();

  // ---- buffer-aware sync and pause-on-drop. One member decides for the party (the "authority"): the host,
  // or while the host is away (disconnected) the first member who isn't. Only a member whose own video is
  // stuck says so; the authority pauses everyone, then plays everyone on from the same moment when all are
  // ready (or after 20 s). A member who drops without leaving pauses the party until they're back (within the
  // server's 15 s grace) or, once they're gone, until someone presses Resume. Pauses, plays and seeks by
  // people always win over both.
  const WAIT_MAX_MS = 20000;
  const hold = (() => {
    const mine = { since: 0, reported: false, lastSent: 0, readySince: 0 }; // my own video
    const bufs = new Map(); // pid -> time of their last "loading" report (what the authority knows)
    const cooldown = new Map(); // pid -> time until which their loading doesn't pause the party (after a timeout)
    const overruled = new Set(); // members whose current stall someone played over: not waited for until they've loaded
    let waiting = null; // authority: { ids: Set, since, position }
    let seen = null; // everyone: the wait as announced { ids: [], since, by }
    let drop = null; // everyone: { ids: Set (away), gone: Set (left for good), by }
    let awayPrev = new Set();
    let lastResume = 0;
    let ticking = false;
    const authority = () => {
      const here = party.members.filter((m) => !m.away);
      return here.some((m) => m.id === party.hostId) ? party.hostId : here[0]?.id || null;
    };
    const amAuthority = () => !!party.me && authority() === party.me && (!party.hostOnly || party.me === party.hostId);
    const rate = () => (IS_ANY && anyV.base !== 1 ? { rate: anyV.base } : {});
    async function setState(playing, position, reason) {
      const state = { playing, position: Math.max(0, Math.round(position)), at: clock.serverNow(), videoId: videoIdFromUrl() || party.state?.videoId, reason, ...rate() };
      await net.request("state", state);
      party.state = { ...state, by: party.me };
      await applyRemote(party.state, reason);
      ui.render();
    }
    function show() {
      ui.hold();
    }
    // ---- authority: start / end waiting for loading members
    const waitLog = new Map(); // pid -> times the party waited for them
    async function startWait(ids) {
      // someone whose video keeps stalling: after 3 waits in 90 s the party stops waiting for them for a minute
      const now = Date.now();
      for (const id of [...ids]) {
        const list = (waitLog.get(id) || []).filter((t) => now - t < 90000);
        if (list.length >= 3) {
          cooldown.set(id, now + 60000);
          waitLog.delete(id);
          ids.delete(id);
        } else waitLog.set(id, [...list, now]);
      }
      if (!ids.size) return;
      const position = expectedPosition(party.state);
      waiting = { ids, since: Date.now(), position };
      log("wait for", [...ids], "at", position);
      try {
        await setState(false, position, "buffer");
      } catch {
        waiting = null;
        return;
      }
      seen = { ids: [...ids], since: Date.now(), by: party.me };
      sendEv({ t: "wait", on: 1, ids: [...ids] });
      show();
      if (!ui.isOpen()) notice(holdText());
    }
    async function endWait(why) {
      const w = waiting;
      waiting = null;
      if (!w) return;
      log("wait over", why);
      lastResume = Date.now();
      if (why === "t") for (const id of w.ids) cooldown.set(id, Date.now() + 60000);
      if (why !== "c") await setState(true, w.position, "resume").catch(() => {});
      sendEv({ t: "wait", on: 0, why, ids: [...w.ids] });
      onWait(party.me, { on: 0, why, ids: [...w.ids] });
    }
    // anyone: the wait as announced by the authority
    function onWait(from, p) {
      const ids = cleanIds(p.ids);
      if (p.on) {
        seen = { ids, since: Date.now(), by: from };
      } else {
        if (p.why === "t" && ids.length) {
          const whose = ids.length > 1 ? "Some videos were" : ids[0] === party.me ? "Your video was" : `${nameOf(ids[0])}'s video was`;
          ui.system(`${whose} still loading after 20 seconds, so the party played on.`);
        }
        seen = null;
      }
      show();
    }
    const names = (ids) => {
      const n = ids.map((id) => (id === party.me ? "you" : nameOf(id)));
      if (n.length <= 2) return n.join(" and ");
      return n.length + " people";
    };
    // ---- my own video, checked every 300 ms while in a party
    async function tick() {
      if (ticking || !party.roomId || !party.state) return;
      ticking = true;
      try {
        const now = Date.now();
        const usable = !!videoIdFromUrl() && !adPlaying() && !(IS_ANY && (anyMismatch || anyV.picking || !anyV.ready));
        const st = usable ? await bridge.status() : null;
        if (!party.roomId || !party.state) return;
        const stuck = !!st && st.ready === false && (party.state.playing || mine.reported);
        if (!mine.reported) overruled.delete(party.me);
        if (stuck) {
          mine.readySince = 0;
          if (!mine.since) mine.since = now;
          if (!mine.reported && party.state.playing && now - mine.since > 1000) {
            mine.reported = true;
            mine.lastSent = now;
            log("my video is stuck loading");
            sendEv({ t: "buf", on: 1 });
          } else if (mine.reported && now - mine.lastSent > 5000) {
            mine.lastSent = now; // still loading (also tells a new authority)
            sendEv({ t: "buf", on: 1 });
          }
        } else {
          mine.since = 0;
          if (mine.reported) {
            if (!mine.readySince) mine.readySince = now;
            if (!st || now - mine.readySince >= 400) {
              mine.reported = false;
              log("my video loaded");
              sendEv({ t: "buf", on: 0 });
            }
          }
        }
        // ---- the authority's part
        if (!amAuthority()) {
          waiting = null;
          return;
        }
        for (const [pid, t] of bufs) if (now - t > 12000 || !party.members.some((m) => m.id === pid && !m.away)) bufs.delete(pid);
        const ids = new Set([...bufs.keys()].filter((pid) => !(cooldown.get(pid) > now) && !overruled.has(pid)));
        if (mine.reported && !(cooldown.get(party.me) > now) && !overruled.has(party.me)) ids.add(party.me);
        if (!waiting) {
          if (seen && seen.by !== party.me && now - seen.since > WAIT_MAX_MS + 5000 && !party.state.playing) {
            // took over from an authority that went away mid-wait
            seen = null;
            await setState(true, party.state.position, "resume").catch(() => {});
            show();
          } else if (prefs.syncWait && ids.size && party.state.playing && now - lastResume > 3000 && !drop) await startWait(ids);
        } else if (!prefs.syncWait || !ids.size) await endWait("r");
        else if (now - waiting.since > WAIT_MAX_MS) await endWait("t");
        else if ([...ids].join() !== [...waiting.ids].join()) {
          waiting.ids = ids;
          seen = { ids: [...ids], since: seen?.since || now, by: party.me };
          sendEv({ t: "wait", on: 1, ids: [...ids] });
          show();
        }
      } catch (e) {
        log("hold", e?.message);
      } finally {
        ticking = false;
      }
    }
    setInterval(tick, 300);

    // ---- pause on drop
    async function onMembers() {
      const away = new Set(party.members.filter((m) => m.away).map((m) => m.id));
      const present = new Set(party.members.map((m) => m.id));
      const newly = [...away].filter((id) => !awayPrev.has(id) && id !== party.me);
      awayPrev = away;
      if (drop) {
        for (const id of [...drop.ids])
          if (!away.has(id)) {
            drop.ids.delete(id);
            if (!present.has(id)) drop.gone.add(id);
          }
        for (const id of newly) drop.ids.add(id);
      }
      if (!drop && newly.length && prefs.dropPause && amAuthority() && party.state?.playing && !waiting) {
        drop = { ids: new Set(newly), gone: new Set(), by: party.me };
        show();
        try {
          await setState(false, expectedPosition(party.state), "drop");
        } catch {
          drop = null;
        }
        if (drop && !ui.isOpen()) notice(holdText());
      }
      // everyone who dropped is back: whoever paused plays on (or the authority, if they're gone too)
      if (drop && !drop.ids.size && !drop.gone.size) {
        const resp = memberHere(drop.by) && !away.has(drop.by) ? drop.by : authority();
        const d = drop;
        if (resp === party.me && party.state && !party.state.playing) {
          drop = null;
          setState(true, party.state.position, "resume").catch(() => (drop = d));
        } else if (resp !== party.me && party.state?.playing) drop = null;
      }
      show();
    }
    // a playback update from someone (already applied)
    function onState(st) {
      const r = st?.reason;
      if (r === "drop") {
        const away = party.members.filter((m) => m.away).map((m) => m.id);
        drop = { ids: new Set(away), gone: new Set(), by: st.by };
      } else if (r === "buffer") {
        // (the wait itself is announced by a signal)
      } else if (r === "resume") {
        drop = null;
        seen = null;
      } else if (r) userAction();
      show();
    }
    // someone played, paused or jumped: they decide, nothing waits or resumes on its own any more
    function userAction() {
      if (waiting) {
        const w = waiting;
        waiting = null;
        lastResume = Date.now();
        for (const id of w.ids) overruled.add(id); // don't pause again for this same stall
        sendEv({ t: "wait", on: 0, why: "c", ids: [...w.ids] });
      }
      seen = null;
      drop = null;
      show();
    }
    function holdText() {
      if (seen?.ids.length) {
        const ids = seen.ids.filter((id) => id === party.me || memberHere(id));
        if (ids.length === 1 && ids[0] === party.me) return "Your video is loading. Everyone is waiting for you…";
        if (ids.length) return `Waiting for ${names(ids)} to load…`;
      }
      if (drop?.ids.size) return `${names([...drop.ids])} disconnected, paused`;
      if (drop?.gone.size) return `${names([...drop.gone])} left. Press Resume to play on.`;
      return "";
    }
    return {
      tick,
      onMembers,
      onState,
      userAction,
      text: holdText,
      get canResume() {
        return !!drop?.gone.size && canControl();
      },
      async resume() {
        if (!party.state || !canControl()) return;
        drop = null;
        seen = null;
        show();
        try {
          await setState(true, party.state.position, "play");
        } catch (e) {
          ui.system(e.message);
        }
      },
      onEv(from, p) {
        if (p.t === "buf") {
          if (p.on) bufs.set(from, Date.now());
          else {
            bufs.delete(from);
            overruled.delete(from);
          }
        } else if (p.t === "wait") onWait(from, p);
      },
      reset() {
        Object.assign(mine, { since: 0, reported: false, lastSent: 0, readySince: 0 });
        bufs.clear();
        cooldown.clear();
        overruled.clear();
        waiting = seen = drop = null;
        awayPrev = new Set();
      },
      // test hook: { waiting, seen, drop, mine } (no secrets)
      get debug() {
        return { waiting: !!waiting, seen: seen && seen.ids, drop: drop && { ids: [...drop.ids], gone: [...drop.gone] }, reported: mine.reported, authority: authority() };
      },
    };
  })();

  // ---- auto-duck (voice chat): while a friend in voice is talking, the video plays at 30% of its volume;
  // 600 ms after they stop it goes back to exactly where it was. Only while you're in voice; a change you make
  // to the volume while it's lowered wins (it isn't put back over).
  const duck = (() => {
    let base = null; // your own volume while it's lowered
    let factor = 1; // 1 = your volume, 0.3 = lowered
    let lastSet = null;
    let quietSince = 0;
    let off = false; // you changed the volume while lowered: leave it alone until everyone's quiet
    let busy = false;
    const directVideo = () => (IS_ANY ? anyV.video : IS_CR ? crFrame.topVideo() : IS_PRIME ? primePlayer()?.video || null : mainVideo());
    async function vol(v) {
      const x = directVideo();
      if (x) {
        if (Number.isFinite(v)) x.volume = Math.min(1, Math.max(0, v));
        return x.volume;
      }
      if (IS_CR) return crFrame.volume(v);
      if (IS_ANY) return anyV.volume(v);
      return null;
    }
    const talking = () =>
      party.members.some((m) => {
        if (m.id === party.me) return false;
        const i = voice.peerInfo(m.id);
        return i.speaking && !i.muted;
      });
    async function restore() {
      if (base !== null) await vol(base);
      base = lastSet = null;
      factor = 1;
    }
    async function tick() {
      if (busy) return;
      busy = true;
      try {
        if (!voice.active || !prefs.autoDuck || !party.roomId) {
          if (base !== null) await restore();
          off = false;
          return;
        }
        const now = Date.now();
        const speak = talking();
        if (speak) quietSince = 0;
        else if (!quietSince) quietSince = now;
        if (off) {
          if (!speak) off = false;
          return;
        }
        const want = speak || (base !== null && now - quietSince < 600) ? 0.3 : 1;
        if (base === null) {
          if (want === 1) return;
          base = await vol();
          lastSet = null;
          if (base === null) return;
        } else if (lastSet !== null) {
          const cur = await vol();
          if (cur !== null && Math.abs(cur - lastSet) > 0.02) {
            // you moved the volume yourself: that's your volume now
            base = lastSet = null;
            factor = 1;
            off = true;
            return;
          }
        }
        if (want === factor) return;
        // smooth: about a quarter of a second each way
        factor = want < factor ? Math.max(want, factor - 0.14) : Math.min(want, factor + 0.14);
        if (factor >= 1) return void (await restore());
        lastSet = await vol(base * factor);
      } catch {
      } finally {
        busy = false;
      }
    }
    setInterval(tick, 50);
    return {
      restore,
      get debug() {
        return { base, factor, off };
      },
    };
  })();

  // ------------------------------------------------------------ 2.3: party recap
  // A shareable card for the party ("2h 14m watched together", who was there, messages, reactions, the
  // biggest moment), made in this tab from what this tab saw. Nothing about it is sent anywhere: the totals
  // are kept for this tab by the background (chrome.storage.session, like the keys) so reloads and episode
  // changes keep them, the picture is drawn on a <canvas> here, and it only leaves the browser if you
  // download or copy it.
  const RECAP_EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  const recap = (() => {
    let s = null; // { v, room, start, site, title, watchMs, voiceMs, msgs, gifs, reacts, emo, by, peak, people, order, moments, seen }
    let seen = new Set(); // chat lines / message reactions already counted (by message id), across reloads
    const imgs = new Map(); // pid -> their photo (data: URL): in memory only, never stored
    let saveT = 0;
    let last = 0;
    let ticks = 0;
    const hueOf = (id) => [...String(id)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7); // same as the panel's
    const fresh = (room) => ({
      v: 1, room, start: Date.now(), site: IS_ANY ? location.hostname : SITE_NAME, title: "", watchMs: 0, voiceMs: 0,
      msgs: 0, gifs: 0, reacts: 0, emo: {}, by: {}, peak: 0, people: {}, order: [], moments: {}, seen: [],
    });
    const num = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
    const counts = (o, keyOk) => {
      const out = {};
      if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (keyOk(k) && Number.isFinite(v) && v > 0) out[k] = v;
      return out;
    };
    // our own stored copy, checked anyway before it's drawn
    function restore(d, room) {
      if (!d || d.v !== 1 || d.room !== room) return null;
      const people = {};
      for (const [id, p] of Object.entries(d.people && typeof d.people === "object" ? d.people : {}))
        if (PID_RE.test(id) && p && typeof p === "object") people[id] = { n: cleanName(p.n) || "Guest", e: cleanAvatar(p.e), hd: cleanHd(p.hd) };
      return {
        ...fresh(room),
        start: num(d.start) || Date.now(),
        site: typeof d.site === "string" ? d.site.slice(0, 60) : fresh(room).site,
        title: typeof d.title === "string" ? cleanSnippet(d.title).slice(0, 60) : "",
        watchMs: num(d.watchMs), voiceMs: num(d.voiceMs), msgs: num(d.msgs), gifs: num(d.gifs), reacts: num(d.reacts), peak: num(d.peak),
        emo: counts(d.emo, (k) => isSingleEmoji(k, 16)),
        by: counts(d.by, (k) => PID_RE.test(k)),
        moments: counts(d.moments, (k) => /^\d{1,5}$/.test(k)),
        people,
        order: (Array.isArray(d.order) ? d.order : []).filter((id) => people[id]).slice(0, 50),
        seen: (Array.isArray(d.seen) ? d.seen : []).filter((x) => typeof x === "string" && x.length <= 80).slice(-600),
      };
    }
    function flush() {
      clearTimeout(saveT);
      saveT = 0;
      if (!s) return;
      s.seen = [...seen].slice(-600);
      chrome.runtime.sendMessage({ cmd: "recap", op: "set", code: s.room, data: s }).catch(() => {});
    }
    function save() {
      if (!s || saveT) return;
      saveT = setTimeout(flush, 500);
    }
    // a reload or an episode change: keep what's counted since the last save
    addEventListener("pagehide", () => s && flush());
    const bump = (o, k, n = 1) => {
      o[k] = (o[k] || 0) + n;
    };
    // the minute of the video something happened at (live lines only: replayed history has no position)
    function moment() {
      const st = party.state;
      if (!st || !Number.isFinite(st.position) || anyLive()) return;
      const k = String(Math.floor(expectedPosition(st) / 60000));
      if (!(k in s.moments) && Object.keys(s.moments).length >= 400) return;
      bump(s.moments, k);
    }
    function markSeen(k) {
      if (seen.has(k)) return false;
      seen.add(k);
      if (seen.size > 800) seen = new Set([...seen].slice(-600));
      return true;
    }
    // every second: time watched together (playing, at least two people connected, not in an ad) and in voice
    setInterval(() => {
      const now = Date.now();
      const dt = Math.min(5000, last ? now - last : 0);
      last = now;
      if (!s || !party.roomId || s.room !== party.roomId) return;
      const here = party.members.filter((m) => !m.away).length;
      if (party.state?.playing && here >= 2 && !adPlaying()) s.watchMs += dt;
      if (voice.active) s.voiceMs += dt;
      if (++ticks % 5 === 0) {
        const t = videoIdFromUrl() ? currentTitle() : "";
        if (t) s.title = t;
      }
      if (ticks % 10 === 0) save(); // the clock is saved every 10 s (and when the page goes away)
    }, 1000);
    return {
      async start(room) {
        if (s?.room === room) return;
        const r = await chrome.runtime.sendMessage({ cmd: "recap", op: "get", code: room }).catch(() => null);
        // left (or moved on) while that was loading: don't bring the record back
        if (party.roomId !== room || s?.room === room) return;
        s = restore(r?.data, room) || fresh(room);
        seen = new Set(s.seen);
        imgs.clear();
        save();
      },
      // a decoded chat line ({ kind: "chat" | "mr" | … }), live or from the history (each counted once)
      line(l, live) {
        if (!s || !l) return;
        if (l.kind === "chat" && l.mid) {
          if (!markSeen("m" + l.mid)) return;
          s.msgs++;
          if (l.gif) s.gifs++;
          bump(s.by, l.id);
        } else if (l.kind === "mr" && l.on && l.id && isSingleEmoji(l.e, 16)) {
          if (!markSeen("r" + l.from + "|" + l.id + "|" + l.e)) return;
          s.reacts++;
          bump(s.emo, l.e);
        } else return;
        if (live) moment();
        save();
      },
      // a 🎉 reaction floating over the video (ours or a friend's)
      react(e) {
        if (!s || !isSingleEmoji(e, 16)) return;
        s.reacts++;
        bump(s.emo, e);
        moment();
        save();
      },
      // who's here: names and pictures as they are now (photos stay in memory)
      people() {
        if (!s) return;
        s.peak = Math.max(s.peak, party.members.length);
        for (const m of party.members) {
          const id = m.id;
          if (!PID_RE.test(String(id))) continue;
          const p = id === party.me ? myPic() : party.profiles.get(id);
          if (!s.people[id] && s.order.length >= 50) continue;
          if (!s.people[id]) s.order.push(id);
          s.people[id] = { n: nameOf(id), e: p?.avatar || null, hd: p?.hd || null };
          if (p?.img) imgs.set(id, p.img);
          else imgs.delete(id);
        }
        save();
      },
      // the party is over for this tab: the totals to draw (or null if there's too little to show)
      async finish(room) {
        const me = party.me;
        clearTimeout(saveT);
        saveT = 0;
        let snap = s?.room === room ? s : null;
        if (!snap) {
          const r = await chrome.runtime.sendMessage({ cmd: "recap", op: "get", code: room }).catch(() => null);
          snap = restore(r?.data, room);
        }
        const photos = new Map(imgs);
        if (s?.room === room) {
          s = null;
          seen = new Set();
          imgs.clear();
        }
        chrome.runtime.sendMessage({ cmd: "recap", op: "del", code: room }).catch(() => {});
        if (!snap) return null;
        const out = { ...snap, end: Date.now(), me, photos };
        return out.watchMs >= 60_000 || out.msgs + out.reacts >= 3 ? out : null;
      },
      // the recap so far, for the Recap button during the party
      current() {
        if (!s || s.room !== party.roomId) return null;
        return { ...s, seen: undefined, end: Date.now(), me: party.me, photos: new Map(imgs) };
      },
      hueOf,
    };
  })();

  // The card itself: 1080 x 1350 (4:5, a full-width Instagram post), drawn with canvas primitives only (no image
  // URLs: HD pictures come from the extension's own files and photos from the decrypted profiles, decoded to
  // bitmaps, like the panel does), in NetParty's colours and its Inter font.
  async function drawRecap(snap) {
    const W = 1080, H = 1350, PAD = 84;
    const FONT = '"NetParty Inter", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    if (![...document.fonts].some((f) => f.family.replace(/"/g, "") === "NetParty Inter"))
      await fetch(chrome.runtime.getURL("fonts/inter-var.woff2"))
        .then((r) => r.arrayBuffer())
        .then((buf) => new FontFace("NetParty Inter", buf, { weight: "100 900", style: "normal" }).load())
        .then((face) => document.fonts.add(face))
        .catch(() => {});
    await Promise.all(["800 40px", "700 24px", "600 24px", "500 24px"].map((w) => document.fonts.load(`${w} "NetParty Inter"`).catch(() => {})));
    const c = el("canvas", { width: String(W), height: String(H), class: "np-recap-canvas" });
    const ctx = c.getContext("2d");
    const f = (w, px) => `${w} ${px}px ${FONT}`;
    const fit = (text, max) => {
      if (ctx.measureText(text).width <= max) return text;
      let t = [...text];
      while (t.length > 1 && ctx.measureText(t.join("") + "…").width > max) t.pop();
      return t.join("").trimEnd() + "…";
    };
    const rr = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };
    const glow = (x, y, r, color) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color);
      g.addColorStop(1, "rgba(13,12,18,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    };
    const dur = (ms) => {
      const m = Math.round(ms / 60000);
      if (m < 1) return "< 1 min";
      if (m < 60) return m + " min";
      return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
    };
    const n = (x) => x.toLocaleString();

    // background: near-black with the brand's two purples glowing from opposite corners, and a little grain
    ctx.fillStyle = "#0d0c12";
    ctx.fillRect(0, 0, W, H);
    glow(160, 120, 760, "rgba(124,92,255,0.50)");
    glow(1000, 1260, 820, "rgba(176,92,255,0.42)");
    glow(980, 420, 420, "rgba(124,92,255,0.16)");
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < 2600; i++) {
      ctx.globalAlpha = 0.02 + rnd() * 0.035;
      ctx.fillRect(rnd() * W, rnd() * H, 1.6, 1.6);
    }
    ctx.globalAlpha = 1;

    // header: the logo mark (icons/mark.svg), the name, "PARTY RECAP" and the date
    ctx.save();
    ctx.translate(PAD, 82);
    ctx.scale(76 / 32, 76 / 32);
    const brand = ctx.createLinearGradient(0, 0, 32, 32);
    brand.addColorStop(0, "#7c5cff");
    brand.addColorStop(1, "#b05cff");
    ctx.fillStyle = brand;
    ctx.globalAlpha = 0.55;
    ctx.fill(new Path2D("M4 6a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-7l-5 4v-4.3A4 4 0 0 1 4 14z"));
    ctx.globalAlpha = 1;
    ctx.fill(new Path2D("M10 14a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8a4 4 0 0 1-2 3.5V30l-5-4h-7a4 4 0 0 1-4-4z"));
    ctx.fillStyle = "#fff";
    ctx.fill(new Path2D("M17 14.5v7l6-3.5z"));
    ctx.restore();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#f3f3f6";
    ctx.font = f(800, 42);
    ctx.fillText("NetParty", PAD + 96, 136);
    ctx.textAlign = "right";
    ctx.font = f(700, 22);
    ctx.letterSpacing = "4px";
    ctx.fillStyle = "#c4b5ff";
    ctx.fillText("PARTY RECAP", W - PAD, 112);
    ctx.letterSpacing = "0px";
    ctx.font = f(500, 22);
    ctx.fillStyle = "#a3a3ad";
    ctx.fillText(new Date(snap.end || Date.now()).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }), W - PAD, 146);
    ctx.textAlign = "left";

    // what we watched
    let y = 262;
    ctx.font = f(700, 22);
    ctx.letterSpacing = "4px";
    ctx.fillStyle = "#a3a3ad";
    ctx.fillText("WE WATCHED", PAD, y);
    ctx.letterSpacing = "0px";
    const title = snap.title || "A watch party";
    const wrap = (px) => {
      ctx.font = f(800, px);
      const out = [];
      let cur = "";
      for (const w of title.split(/\s+/).filter(Boolean)) {
        const t = cur ? cur + " " + w : w;
        if (ctx.measureText(t).width > W - PAD * 2 && cur) {
          out.push(cur);
          cur = w;
        } else cur = t;
      }
      if (cur) out.push(cur);
      return out.length ? out : [title];
    };
    // one line at 70px; a longer title gets two lines at 58px (anything past that ends in "…")
    let tPx = 70, lines = wrap(70);
    if (lines.length > 1) {
      tPx = 58;
      lines = wrap(58);
    }
    const shown = lines.slice(0, 2);
    if (lines.length > 2) shown[1] = fit(lines.slice(1).join(" "), W - PAD * 2);
    shown[0] = fit(shown[0], W - PAD * 2);
    const tLead = tPx === 70 ? 80 : 68;
    ctx.fillStyle = "#ffffff";
    y += tPx + 10;
    for (const l of shown) {
      ctx.fillText(l, PAD, y);
      y += tLead;
    }
    // "on Netflix" chip
    y -= tLead - 66;
    ctx.font = f(600, 24);
    const chip = fit("on " + snap.site, W - PAD * 2 - 44);
    const cw = ctx.measureText(chip).width + 44;
    rr(PAD, y - 32, cw, 48, 24);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#e9e5ff";
    ctx.fillText(chip, PAD + 22, y);
    const chipBottom = y + 16;

    // The bottom of the card is fixed: the footer, and above it the 2 x 2 grid of numbers. The middle (the big
    // number, the pictures, the names) fills what's left between the chip and the grid, and the big number
    // shrinks if a long title has taken some of that room.
    const FOOT = H - 96, GAP = 20, CH = 136;
    const gridTop = FOOT - 36 - (CH * 2 + GAP);
    const R = 52, STEP = 86;
    const big = dur(snap.watchMs);
    let bigPx = 156, asc = 0;
    const measureBig = () => {
      ctx.font = f(800, bigPx);
      const m = ctx.measureText(big);
      asc = m.actualBoundingBoxAscent || bigPx * 0.74;
      return m.width;
    };
    while (bigPx > 96 && measureBig() > W - PAD * 2) bigPx -= 4;
    // chip → (44) big number → (54) "watched together" → (40) pictures → (54) names → (44) grid
    const block = () => 44 + asc + 54 + 40 + R * 2 + 54;
    while (bigPx > 96 && chipBottom + block() > gridTop - 44) {
      bigPx -= 4;
      measureBig();
    }
    const spare = Math.max(0, gridTop - 44 - (chipBottom + block()));

    // the big number
    y = chipBottom + 44 + spare / 2 + asc;
    ctx.font = f(800, bigPx);
    const g = ctx.createLinearGradient(PAD, y - asc, PAD + ctx.measureText(big).width, y);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(1, "#c9b8ff");
    ctx.fillStyle = g;
    ctx.fillText(big, PAD - Math.round(bigPx / 26), y);
    ctx.font = f(600, 32);
    ctx.fillStyle = "#c9c4dc";
    ctx.fillText("watched together", PAD, y + 54);

    // who was there: a stack of pictures and their names
    y += 54 + 40 + spare / 2 + R;
    const ids = snap.order.filter((id) => snap.people[id]);
    const byMsgs = (a, b) => (snap.by[b] || 0) - (snap.by[a] || 0);
    const faces = [...ids].sort((a, b) => (a === snap.me ? -1 : b === snap.me ? 1 : byMsgs(a, b))).slice(0, 6);
    const decode = async (dataUrl) => {
      if (typeof dataUrl !== "string" || !IMG_RE.test(dataUrl)) return null;
      const [head, b64] = dataUrl.split(",");
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      try {
        return await createImageBitmap(new Blob([bytes], { type: head.slice(5, head.indexOf(";")) }));
      } catch {
        return null;
      }
    };
    const pics = await Promise.all(
      faces.map(async (id) => {
        const p = snap.people[id];
        const photo = cleanImg(snap.photos?.get(id));
        if (photo) return { kind: "photo", bmp: await decode(photo) };
        if (p.hd) {
          const r = await chrome.runtime.sendMessage({ cmd: "avatarFile", id: p.hd.slice(3) }).catch(() => null);
          const bmp = await decode(r?.dataUrl);
          if (bmp) return { kind: "hd", bmp };
        }
        return { kind: "emoji", e: p.e || (HD.get(p.hd?.slice(3))?.emoji) || globalThis.NP_EMOJI?.avatars?.[recap.hueOf(id) % (globalThis.NP_EMOJI?.avatars?.length || 1)] || "🙂" };
      }),
    );
    faces.forEach((id, i) => {
      const cx = PAD + R + i * STEP, cy = y;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
      ctx.fillStyle = "#0d0c12";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${recap.hueOf(id)} 70% 82%)`;
      ctx.fill();
      const pic = pics[i];
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();
      if (pic.kind === "photo" && pic.bmp) {
        const s = Math.max((R * 2) / pic.bmp.width, (R * 2) / pic.bmp.height);
        ctx.drawImage(pic.bmp, cx - (pic.bmp.width * s) / 2, cy - (pic.bmp.height * s) / 2, pic.bmp.width * s, pic.bmp.height * s);
      } else if (pic.kind === "hd") {
        const s = (R * 2 * 0.86) / Math.max(pic.bmp.width, pic.bmp.height);
        ctx.drawImage(pic.bmp, cx - (pic.bmp.width * s) / 2, cy - (pic.bmp.height * s) / 2, pic.bmp.width * s, pic.bmp.height * s);
      } else {
        ctx.font = `62px ${RECAP_EMOJI}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(pic.e || "🙂", cx, cy + 4);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
      }
      ctx.restore();
    });
    const more = ids.length - faces.length;
    if (more > 0) {
      const cx = PAD + R + faces.length * STEP, cy = y;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
      ctx.fillStyle = "#0d0c12";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = "#2a2a33";
      ctx.fill();
      ctx.font = f(800, 34);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.fillText("+" + more, cx, cy + 12);
      ctx.textAlign = "left";
    }
    const others = ids.filter((id) => id !== snap.me).sort(byMsgs).map((id) => snap.people[id].n);
    const who = !others.length ? "Just you" : others.length <= 3 ? "With " + others.slice(0, -1).join(", ") + (others.length > 1 ? " and " : "") + others.at(-1) : `With ${others.slice(0, 2).join(", ")} and ${others.length - 2} more`;
    ctx.font = f(600, 30);
    ctx.fillStyle = "#e9e5ff";
    ctx.fillText(fit(who, W - PAD * 2), PAD, y + R + 54);

    // four numbers, the ones with something in them first
    const top = Object.entries(snap.emo).sort((a, b) => b[1] - a[1])[0];
    const peakMin = Object.entries(snap.moments).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
    const chatty = Object.entries(snap.by).filter(([id]) => snap.people[id]).sort((a, b) => b[1] - a[1])[0];
    const stats = [
      { v: n(snap.msgs), l: snap.gifs ? `MESSAGES · ${n(snap.gifs)} GIF${snap.gifs === 1 ? "" : "S"}` : "MESSAGES", has: snap.msgs > 0 },
      { v: n(snap.reacts), l: "REACTIONS", e: top?.[0], has: snap.reacts > 0 },
      { v: peakMin ? fmt(Number(peakMin[0]) * 60000) : "", l: "BIGGEST MOMENT", has: !!peakMin && peakMin[1] >= 2 },
      { v: chatty ? snap.people[chatty[0]].n : "", l: "MOST CHATTY", has: !!chatty && others.length > 0 },
      { v: dur(snap.voiceMs), l: "IN VOICE", has: snap.voiceMs >= 60_000 },
      { v: n(Math.max(snap.peak, ids.length ? 1 : 0)), l: "PEOPLE AT ONCE", has: snap.peak >= 2 },
    ];
    const pickStats = [...stats.filter((x) => x.has), ...stats.filter((x) => !x.has && x.v)].slice(0, 4);
    const CW = (W - PAD * 2 - GAP) / 2;
    y = gridTop;
    pickStats.forEach((st, i) => {
      const x = PAD + (i % 2) * (CW + GAP), yy = y + Math.floor(i / 2) * (CH + GAP);
      rr(x, yy, CW, CH, 28);
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = f(700, 20);
      ctx.letterSpacing = "3px";
      ctx.fillStyle = "#a3a3ad";
      ctx.fillText(fit(st.l, CW - 56), x + 28, yy + 44);
      ctx.letterSpacing = "0px";
      ctx.font = f(800, st.l === "MOST CHATTY" ? 46 : 56);
      ctx.fillStyle = "#ffffff";
      const room = st.e ? CW - 56 - 76 : CW - 56;
      ctx.fillText(fit(st.v, room), x + 28, yy + 108);
      if (st.e) {
        ctx.font = `54px ${RECAP_EMOJI}`;
        ctx.textAlign = "right";
        ctx.fillText(st.e, x + CW - 26, yy + 104);
        ctx.textAlign = "left";
      }
    });

    // footer
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fillRect(PAD, FOOT, W - PAD * 2, 1.5);
    ctx.font = f(800, 28);
    ctx.fillStyle = "#f3f3f6";
    ctx.fillText("netparty.tech", PAD, FOOT + 54);
    ctx.font = f(500, 22);
    ctx.fillStyle = "#a3a3ad";
    ctx.textAlign = "right";
    ctx.fillText("Watch together, in sync", W - PAD, FOOT + 52);
    ctx.textAlign = "left";
    return c;
  }

  // The viewer (and the "your recap is ready" card that offers it). Its own overlay, so it can show after the
  // chat panel has gone (the party ended, you left). Keys typed in it are kept from the site (early.js).
  const recapView = (() => {
    let host = null, sh = null, offerEl = null, viewEl = null, offerT = 0;
    const CSS = `
:host { all: initial; }
.w { font: 14px/1.4 "NetParty Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f3f3f6; }
.offer { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; display: flex; align-items: center; gap: 12px;
  padding: 12px 12px 12px 16px; border-radius: 16px; background: #1b1b22; border: 1px solid #7c5cff; box-shadow: 0 12px 40px rgba(0,0,0,.55);
  transform: translateY(16px); opacity: 0; transition: transform .25s, opacity .25s; }
.offer.s { transform: none; opacity: 1; }
.offer b { display: block; font-size: 14px; } .offer small { color: #a3a3ad; font-size: 12px; }
.btn { border: 0; border-radius: 999px; padding: 9px 16px; font: inherit; font-weight: 700; font-size: 13px; cursor: pointer; background: #6c4cf5; color: #fff; }
.btn:hover { background: #7c5cff; } .btn.soft { background: #2a2a33; color: #f3f3f6; } .btn.soft:hover { background: #3a3a46; }
.btn:focus-visible, .x:focus-visible { outline: 2px solid #a48bff; outline-offset: 2px; }
.x { border: 0; background: none; color: #a3a3ad; width: 30px; height: 30px; border-radius: 50%; font: 700 18px/1 system-ui; cursor: pointer; }
.x:hover { background: #2a2a33; color: #fff; }
.bd { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; background: rgba(6,6,10,.72); backdrop-filter: blur(6px); }
.card { width: min(440px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; display: flex; flex-direction: column; gap: 14px;
  padding: 18px; border-radius: 20px; background: #141418; border: 1px solid #34343d; box-shadow: 0 24px 60px rgba(0,0,0,.6); }
.top { display: flex; align-items: center; justify-content: space-between; } .top h2 { margin: 0; font-size: 16px; }
.np-recap-canvas { display: block; width: 100%; height: auto; border-radius: 14px; background: #0d0c12; }
.row { display: flex; gap: 8px; flex-wrap: wrap; } .row .btn { flex: 1; }
.note { margin: 0; color: #a3a3ad; font-size: 12px; } .msg { margin: 0; min-height: 18px; color: #c4b5ff; font-size: 13px; }
@media (prefers-reduced-motion: reduce) { .offer { transition: none; } }`;
    function mountHost() {
      if (!host) {
        host = el("div", { id: "netparty-recap" });
        sh = host.attachShadow({ mode: "open" });
        sh.append(el("style", {}, CSS));
        // clicks and scrolls in the overlay never reach the player underneath
        for (const evt of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel", "contextmenu"]) host.addEventListener(evt, (e) => e.stopPropagation());
      }
      const fs = document.fullscreenElement;
      const parent = (fs && fs.localName !== "video" && fs.localName !== "iframe" ? fs : null) || document.body;
      if (host.parentElement !== parent) parent.append(host);
    }
    function hideOffer() {
      clearTimeout(offerT);
      offerEl?.remove();
      offerEl = null;
    }
    function close() {
      viewEl?.remove();
      viewEl = null;
    }
    window.__netpartyRecapKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (viewEl) close();
        else hideOffer();
      }
    };
    async function open(snap) {
      hideOffer();
      close();
      mountHost();
      const msg = el("p", { class: "msg", role: "status" });
      const slot = el("div", {}, el("p", { class: "note" }, "Drawing your recap…"));
      const dl = el("button", { type: "button", class: "btn", disabled: "" }, "Download");
      const cp = el("button", { type: "button", class: "btn soft", disabled: "" }, "Copy image");
      viewEl = el(
        "div",
        { class: "w bd", onclick: (e) => e.target === viewEl && close() },
        el(
          "div",
          { class: "card", role: "dialog", "aria-modal": "true", "aria-label": "Your party recap" },
          el("div", { class: "top" }, el("h2", {}, "Your party recap"), el("button", { type: "button", class: "x", title: "Close (Esc)", "aria-label": "Close", onclick: close }, "×")),
          slot,
          el("div", { class: "row" }, dl, cp),
          msg,
          el("p", { class: "note" }, "Made on this device from what your browser saw. It's only shared if you download or copy it."),
        ),
      );
      sh.append(viewEl);
      const view = viewEl;
      let canvas;
      try {
        canvas = await drawRecap(snap);
      } catch (e) {
        if (viewEl === view) slot.replaceChildren(el("p", { class: "note" }, "Couldn't draw the recap."));
        return;
      }
      if (viewEl !== view) return;
      slot.replaceChildren(canvas);
      const blob = () => new Promise((r) => canvas.toBlob(r, "image/png"));
      const stamp = new Date(snap.end || Date.now()).toISOString().slice(0, 10);
      dl.disabled = cp.disabled = false;
      dl.onclick = () => {
        // a data: URL made right here, in the click (no await, so the click still counts as the user's)
        let href;
        try {
          href = canvas.toDataURL("image/png");
        } catch {
          return void (msg.textContent = "Couldn't make the image.");
        }
        const a = el("a", { href, download: `NetParty recap ${stamp}.png` });
        sh.append(a);
        a.click();
        a.remove();
        msg.textContent = "Saved to your downloads.";
      };
      cp.onclick = async () => {
        try {
          const b = await blob();
          await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]);
          msg.textContent = "Copied. Paste it into a story, post or chat.";
        } catch {
          msg.textContent = "Couldn't copy the image here. Use Download instead.";
        }
      };
      dl.focus();
    }
    function offer(snap) {
      hideOffer();
      mountHost();
      offerEl = el(
        "div",
        { class: "w offer", role: "status" },
        el("div", {}, el("b", {}, "Your party recap is ready"), el("small", {}, "A picture of tonight to share")),
        el("button", { type: "button", class: "btn", onclick: () => open(snap) }, "View"),
        el("button", { type: "button", class: "x", title: "Not now", "aria-label": "Not now", onclick: hideOffer }, "×"),
      );
      sh.append(offerEl);
      requestAnimationFrame(() => offerEl?.classList.add("s"));
      offerT = setTimeout(hideOffer, 20_000);
    }
    return { open, offer, close, get isOpen() { return !!viewEl; } };
  })();

  // ------------------------------------------------------------------ UI
  // Lives in a shadow root so the streaming site's CSS can't break it.
  const ui = (() => {
    const E = globalThis.NP_EMOJI || { avatars: ["🙂"], reactions: ["😂", "😭", "💀", "🥰", "😱"], categories: [] };
    let chatStick = true, chatSaved = 0; // chat scroll: following the newest line, or scrolled-up offset
    let host, shadow, root, panel, peopleEl, chatEl, input, sendBtn, codeEl, metaEl, voiceBox, toggleBtn, badge, toastEl;
    let composer, floatLayer, emojiBtn, gifBtn, reactBtn, fontBtn, camLayer, headEl, leaveIcon;
    let setBtn, typingEl, holdBar, holdTxt, holdBtn; // 2.2
    let anyRow, anyNote, theaterBtn, fsBtn, theaterIcon; // any-video mode: Theater, Full screen, notes
    let open = false;
    let unread = 0;
    let unreadAt = false; // an unread line mentions you (2.2)
    let toastTimer = 0;
    let peopleSig = "";

    const hue = (id) => [...String(id)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
    // a member's picture (from their decrypted profile); none yet: a stable one from their id
    const picOf = (pid) => (pid === party.me ? myPic() : party.profiles.get(pid))?.avatar || E.avatars[hue(pid || "?") % E.avatars.length];
    // 2.2: the whole picture: emoji (always, the fallback), HD picture and photo (when set)
    const picSpec = (pid) => {
      const p = pid === party.me ? myPic() : party.profiles.get(pid);
      return { e: picOf(pid), hd: p?.hd || null, img: p?.img || null };
    };
    const fnv = (str) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
      return (h >>> 0).toString(36);
    };
    const imgKeys = new Map(); // photo -> its short key (photos are long strings)
    const picKey = (sp) => {
      if (sp.img) {
        if (!imgKeys.has(sp.img)) {
          if (imgKeys.size > 200) imgKeys.clear();
          imgKeys.set(sp.img, "i" + sp.img.length + "." + fnv(sp.img));
        }
        return imgKeys.get(sp.img);
      }
      return sp.hd ? sp.hd : "e" + sp.e;
    };
    // Pictures are drawn without ever loading a URL from outside: an HD picture's bytes come from the
    // extension (background worker), a photo's from the member's encrypted profile. First shown from a
    // blob: URL; if the site's CSP (img-src) blocks that, from a data: URL; if that's blocked too, drawn
    // on a <canvas> (not subject to img-src). Until it's ready, and if it can't be decoded, the emoji shows.
    const pics = (() => {
      let mode = "blob"; // -> "data" -> "canvas"
      const src = new Map(); // key -> Promise<{ dataUrl, blob, bmp, url } | null>
      function load(k, sp) {
        if (!src.has(k)) {
          if (src.size > 150)
            for (const [key, pr] of src) {
              if (src.size <= 100) break;
              src.delete(key);
              pr.then((x) => x?.url && URL.revokeObjectURL(x.url));
            }
          src.set(
            k,
            (async () => {
              const dataUrl = sp.img ? cleanImg(sp.img) : (await chrome.runtime.sendMessage({ cmd: "avatarFile", id: sp.hd.slice(3) }).catch(() => null))?.dataUrl;
              if (typeof dataUrl !== "string" || !IMG_RE.test(dataUrl)) return null;
              const [head, b64] = dataUrl.split(",");
              const bin = atob(b64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              const blob = new Blob([bytes], { type: head.slice(5, head.indexOf(";")) });
              let bmp;
              try {
                bmp = await createImageBitmap(blob); // a real image? (not subject to the page's CSP)
              } catch {
                return null;
              }
              if (!bmp.width || !bmp.height || bmp.width > 512 || bmp.height > 512) return null;
              return { dataUrl, blob, bmp, url: null };
            })().catch(() => null),
          );
        }
        return src.get(k);
      }
      async function show(holder, k, sp) {
        const x = await load(k, sp);
        if (!x || holder.dataset.pk !== k) return;
        const done = (node) => {
          if (holder.dataset.pk !== k) return;
          holder.classList.add("np-pic-img", sp.img ? "np-pic-photo" : "np-pic-hd");
          holder.replaceChildren(node);
        };
        const attempt = () => {
          if (holder.dataset.pk !== k) return;
          if (mode === "canvas") {
            const c = el("canvas", { class: "np-pic", "aria-hidden": "true" });
            c.width = x.bmp.width;
            c.height = x.bmp.height;
            c.getContext("2d")?.drawImage(x.bmp, 0, 0);
            return done(c);
          }
          const m = mode;
          const img = el("img", { class: "np-pic", alt: "", draggable: "false", decoding: "async", "aria-hidden": "true" });
          img.onload = () => done(img);
          img.onerror = () => {
            if (mode === m) mode = m === "blob" ? "data" : "canvas";
            attempt();
          };
          if (m === "blob") img.src = x.url ||= URL.createObjectURL(x.blob);
          else img.src = x.dataUrl;
        };
        attempt();
      }
      return { show, get mode() { return mode; } };
    })();
    // put a picture into its holder (people row, chat line, camera tile, mention list, picker);
    // does nothing when it already shows that picture
    function paintSpec(holder, sp) {
      const k = picKey(sp);
      if (holder.dataset.pk === k) return holder;
      holder.dataset.pk = k;
      holder.classList.remove("np-pic-img", "np-pic-photo", "np-pic-hd");
      holder.textContent = sp.e;
      if (sp.img || sp.hd) pics.show(holder, k, sp);
      return holder;
    }
    const paintPic = (holder, pid) => paintSpec(holder, picSpec(pid));
    // SVG icons are built node by node: some sites (YouTube) enforce Trusted Types, so no innerHTML
    const SVG_NS = "http://www.w3.org/2000/svg";
    const svg = (markup) => {
      const s = document.createElementNS(SVG_NS, "svg");
      s.setAttribute("viewBox", "0 0 24 24");
      s.setAttribute("aria-hidden", "true");
      for (const [, tag, attrs] of markup.matchAll(/<(\w+)([^>]*?)\/>/g)) {
        const n = document.createElementNS(SVG_NS, tag);
        for (const [, k, v] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) n.setAttribute(k, v);
        s.append(n);
      }
      return s;
    };
    const ICON = {
      chat: '<path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/>',
      send: '<path fill="currentColor" d="M3 20.5 21 12 3 3.5v6.6l12 1.9-12 1.9z"/>',
      close: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/>',
      link: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
      mic: '<path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12z"/>',
      micOff: '<path fill="currentColor" d="M15 10.6V6a3 3 0 0 0-5.9-.8zM19 12h-2a5 5 0 0 1-.6 2.3l1.5 1.5A7 7 0 0 0 19 12zM4.3 3 3 4.3l6 6V12a3 3 0 0 0 4.5 2.6l1.6 1.6A5 5 0 0 1 7 12H5a7 7 0 0 0 6 6.9V21h2v-2.1a7 7 0 0 0 3.6-1.5l3.1 3.1 1.3-1.3z"/>',
      phoneOff: '<path fill="currentColor" d="M12 9c-1.6 0-3.1.3-4.6.7v3.1c0 .4-.2.7-.6.9-.9.4-1.7 1-2.4 1.6-.2.2-.4.3-.7.3s-.5-.1-.7-.3L.3 12.8a1 1 0 0 1 0-1.4C3.4 8.5 7.5 7 12 7s8.6 1.5 11.7 4.4a1 1 0 0 1 0 1.4L21 15.4c-.2.2-.4.3-.7.3s-.5-.1-.7-.3c-.7-.6-1.5-1.2-2.4-1.6-.4-.2-.6-.5-.6-.9V9.7C15.1 9.3 13.6 9 12 9z"/>',
      crown: '<path fill="currentColor" d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5z"/>',
      reply: '<path fill="currentColor" d="M10 9V5L3 12l7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/>',
      smile: '<path fill="none" stroke="currentColor" stroke-width="2" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M8 14.5a5 5 0 0 0 8 0"/><path fill="currentColor" d="M9 8.5a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm6 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/>',
      edit: '<path fill="currentColor" d="M3 17.2V21h3.8L17.8 9.9l-3.7-3.7zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7z"/>',
      clock: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4v5l3 2"/>',
      cam: '<path fill="currentColor" d="M4 6h11a2 2 0 0 1 2 2v1.6l4-2.6v10l-4-2.6V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/>',
      camOff: '<path fill="currentColor" d="M3.3 2 2 3.3 4.7 6H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h11c.4 0 .8-.1 1.1-.3l4.6 4.6 1.3-1.3zM21 7l-4 2.6V8a2 2 0 0 0-2-2H9.2L21 17.8z"/>',
      chevron: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/>',
      popout: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
      dockIn: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path fill="currentColor" d="M14 6h6v12h-6z"/>',
      grip: '<circle fill="currentColor" cx="9" cy="6" r="1.7"/><circle fill="currentColor" cx="15" cy="6" r="1.7"/><circle fill="currentColor" cx="9" cy="12" r="1.7"/><circle fill="currentColor" cx="15" cy="12" r="1.7"/><circle fill="currentColor" cx="9" cy="18" r="1.7"/><circle fill="currentColor" cx="15" cy="18" r="1.7"/>',
      resize: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M20 9 9 20M20 15l-5 5"/>',
      leave: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>',
      check: '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/>',
      theater: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M3 6h18v12H3z"/><path fill="currentColor" d="M5 8h10v8H5z"/>',
      expand: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
      pin: '<path fill="currentColor" d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5a3 3 0 0 1-3 3v2h5.97v7l1 1 1-1v-7H19v-2a3 3 0 0 1-3-3z"/>',
      trash: '<path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/>',
      eyeOff: '<path fill="currentColor" d="M12 7a5 5 0 0 1 4.64 6.83l2.92 2.92A11.8 11.8 0 0 0 23 12c-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16A4.9 4.9 0 0 1 12 7zM2 4.27l2.74 2.74A11.8 11.8 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3zM7.53 9.8l1.55 1.55A3 3 0 0 0 12 15c.22 0 .44-.03.65-.08l1.55 1.55A5 5 0 0 1 7.53 9.8z"/>',
      gear: '<path fill="currentColor" d="M19.14 12.94a7.1 7.1 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.47.47 0 0 0-.47.41l-.36 2.54a7.3 7.3 0 0 0-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58a7.3 7.3 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/>',
      // 2.3: invite sharing, recap, host controls, per-person volume
      whatsapp: '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" d="M12 3.2a8.8 8.8 0 0 0-7.6 13.2L3.2 20.8l4.5-1.2A8.8 8.8 0 1 0 12 3.2z"/><path fill="currentColor" d="M8.7 7.7c.2-.4.5-.5.8-.5h.6c.2 0 .4.1.5.4l.8 1.9c.1.3 0 .5-.1.7l-.6.7c-.1.2-.1.4 0 .6.6 1.1 1.5 2 2.6 2.6.2.1.4.1.6 0l.7-.6c.2-.2.5-.2.7-.1l1.9.8c.3.1.4.3.4.5v.6c0 .3-.2.6-.5.8-.6.4-1.4.6-2.2.4-2.6-.6-5-3-5.6-5.6-.2-.8 0-1.6.4-2.2z"/>',
      discord: '<path fill="currentColor" d="M19.3 5.4A16.6 16.6 0 0 0 15.2 4l-.5 1a15 15 0 0 0-5.4 0l-.5-1a16.6 16.6 0 0 0-4.1 1.4C2.1 9.3 1.4 13.1 1.7 16.9a16.8 16.8 0 0 0 5.1 2.6l1.1-1.8c-.6-.2-1.2-.5-1.8-.9l.4-.3a11.9 11.9 0 0 0 10.2 0l.4.3c-.6.4-1.2.7-1.8.9l1.1 1.8a16.8 16.8 0 0 0 5.1-2.6c.4-4.4-.7-8.2-2.4-11.5zM8.5 14.6c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm7 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z"/>',
      instagram: '<rect x="3.2" y="3.2" width="17.6" height="17.6" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.2" cy="6.8" r="1.25" fill="currentColor"/>',
      qr: '<path fill="none" stroke="currentColor" stroke-width="2" d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path fill="currentColor" d="M6.5 6.5h1v1h-1zM16.5 6.5h1v1h-1zM6.5 16.5h1v1h-1zM14 14h3v3h-3zM17 17h3v3h-3zM14 19h2v1h-2zM19 14h1v2h-1z"/>',
      lock: '<path fill="currentColor" d="M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm2 0h6V7a3 3 0 0 0-6 0z"/>',
      sparkle: '<path fill="currentColor" d="M11 2.5l2 5.9 5.9 2-5.9 2-2 5.9-2-5.9-5.9-2 5.9-2zM18.5 14.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/>',
      volume: '<path fill="currentColor" d="M4 9h4l5-4v14l-5-4H4zm12.4-2.6a7 7 0 0 1 0 11.2l-1.2-1.6a5 5 0 0 0 0-8z"/>',
      userX: '<path fill="currentColor" d="M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.3 0-7 1.7-7 4v2h11.3a6 6 0 0 1-.3-1.8c0-1.6.6-3 1.6-4.1A12 12 0 0 0 10 14zm9.1-.5L17.5 15l-1.6-1.5-1.4 1.4 1.6 1.6-1.6 1.6 1.4 1.4 1.6-1.6 1.6 1.6 1.4-1.4-1.6-1.6 1.6-1.6z"/>',
    };
    const iconBtn = (icon, title, onclick, cls = "") =>
      el("button", { type: "button", class: "np-icon " + cls, title, "aria-label": title, onclick }, svg(icon));

    // ---------------------------------------------------------- composer
    let lastSel = null; // caret position in the chat box, kept while a picker has focus
    function rememberSel() {
      if (input && shadow?.activeElement === input) lastSel = [input.selectionStart, input.selectionEnd];
    }
    function insertAtCursor(text) {
      const [a, b] = lastSel || [input.value.length, input.value.length];
      if (input.value.length - (b - a) + text.length > 500) return;
      input.setRangeText(text, a, b, "end");
      lastSel = [input.selectionStart, input.selectionEnd];
      updateSend();
      input.focus();
    }
    // 2.2: the chat box's text -> { text, sp?, mn? }: spoilers (||hidden|| anywhere, or the whole message with
    // the Spoiler switch on) become "[spoiler]" placeholders, and "@Name" of a member becomes a mention
    function compose(raw, whole) {
      let text = "";
      const sp = [];
      const hide = (hid) => {
        sp.push({ i: text.length, n: SP_PH.length, s: hid });
        text += SP_PH;
      };
      if (whole) hide(raw);
      else {
        let at = 0;
        for (const m of raw.matchAll(/\|\|([\s\S]+?)\|\|/g)) {
          const hid = m[1].trim();
          if (!hid || sp.length >= 10) continue;
          text += raw.slice(at, m.index);
          hide(hid);
          at = m.index + m[0].length;
        }
        text += raw.slice(at);
      }
      text = text.trim();
      if (!text || text.length > 500) return null;
      const mn = [];
      const taken = sp.map((x) => [x.i, x.i + x.n]);
      const low = text.toLowerCase();
      const hay = low.length === text.length ? low : text;
      const people = party.members
        .map((m) => ({ id: m.id, name: nameOf(m.id) }))
        .filter((x) => x.name && x.id !== party.me)
        .sort((a, b) => b.name.length - a.name.length);
      for (const who of people) {
        const needle = "@" + (hay === low ? who.name.toLowerCase() : who.name);
        for (let i = hay.indexOf(needle); i >= 0 && mn.length < 10; i = hay.indexOf(needle, i + 1)) {
          const end = i + needle.length;
          if (/[\p{L}\p{N}_]/u.test(text[end] || "") || (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1]))) continue;
          if (taken.some(([a, b]) => i < b && a < end)) continue;
          mn.push({ p: who.id, i, n: end - i });
          taken.push([i, end]);
        }
      }
      return { text, ...(sp.length ? { sp } : {}), ...(mn.length ? { mn } : {}) };
    }
    function sendChat() {
      const raw = input.value.trim();
      if (!raw) return;
      const built = compose(raw.slice(0, 500), spoilerOn);
      if (!built) return system("Message not sent: it's too long.");
      input.value = "";
      lastSel = null;
      mention.close();
      if (spoilerOn) setSpoiler(false);
      updateSend();
      typing.sent();
      if (editing) {
        const ed = editing;
        edit.cancel();
        sendLine({ t: "me", id: ed.mid, ...built }).catch((err) => system("Edit not saved: " + err.message));
      } else sendLine({ t: "text", ...built }).catch((err) => system("Message not sent: " + err.message));
      input.focus();
    }
    // chat text or GIF (with a fresh message id, and the quote when replying), or a message
    // reaction { t: "mr" }, encrypted for the party
    async function sendLine(payload) {
      if (!party.roomId || !party.me || !e2e.ready) throw new Error("Not in a party.");
      if (payload.t === "text" || payload.t === "gif") {
        payload = { ...payload, mid: newMid() };
        if (replyTo) {
          const r = replyTo;
          payload.re = { ...(r.id ? { id: r.id } : {}), ...(r.uid ? { uid: r.uid } : {}), ...(r.name ? { name: r.name } : {}), ...(r.g ? { g: 1 } : r.sp ? { sp: 1, s: "Spoiler" } : { s: r.s }) };
          reply.cancel();
        }
      }
      let ct = await e2e.seal("chat", party.me, payload);
      // a long message plus its quote can outgrow the size every server accepts: drop the quoted
      // name, then shorten the snippet, then drop the quote (the message itself always goes)
      while (ct.length > CT_MAX.chat && payload.re) {
        const re = { ...payload.re };
        if (re.name) delete re.name;
        else if (re.s && re.s.length > 8) re.s = [...re.s].slice(0, Math.floor([...re.s].length / 2)).join("");
        else re.drop = true;
        payload = { ...payload, re };
        if (re.drop) delete payload.re;
        ct = await e2e.seal("chat", party.me, payload);
      }
      if (ct.length > CT_MAX.chat) throw new Error("Too long.");
      await net.request("chat", { ct });
    }
    const updateSend = () => (sendBtn.disabled = !input.value.trim());

    // keys typed in the panel arrive here first (early.js), before the site's hotkeys
    window.__netpartyKey = (e) => {
      if (e.isComposing || !shadow) return;
      const active = shadow.activeElement;
      if (camUi.key(e)) return;
      if (active && active === avatarPicker.nameInput && (e.key === "Enter" || e.key === "Escape")) {
        // Enter saves the name, Esc throws the edit away; either way the profile closes
        e.preventDefault();
        if (e.key === "Enter") avatarPicker.saveName();
        else avatarPicker.revert();
        pops.close();
        input.focus();
        return;
      }
      if (active === input && mention.key(e)) return;
      if (e.key === "Enter" && !e.shiftKey && active === input) {
        e.preventDefault();
        sendChat();
      } else if (e.key === "Enter" && active === gif.inputEl) {
        e.preventDefault();
        gif.searchNow();
      } else if (e.key === "Enter" && active && active === emoji.searchEl) {
        e.preventDefault();
        emoji.pickFirst();
      } else if (e.key === "Escape" && active && active === emoji.searchEl && emoji.clearSearch()) {
        e.preventDefault();
      } else if (e.key === "Escape") {
        if (pops.current) {
          e.preventDefault();
          pops.close();
          input.focus();
        } else if (edit.cancel() || reply.cancel()) {
          e.preventDefault();
          input.focus();
        } else hide();
      }
    };

    // ---------------------------------------------------------- popovers
    // One open at a time, anchored inside the panel. They close on Esc, on the button
    // that opened them, and on any click outside them (in the panel or on the page).
    const pops = {
      current: null,
      opener: null,
      open(node, opener, place = "bottom") {
        if (this.current === node) return this.close();
        this.close();
        this.current = node;
        this.opener = opener;
        node.classList.add("np-pop-open");
        if (place === "bottom") {
          node.style.top = "";
          node.style.bottom = composer.offsetHeight + 6 + "px";
        } else {
          node.style.bottom = "";
          node.style.top = place + "px";
        }
        opener?.setAttribute("aria-expanded", "true");
      },
      close() {
        const node = this.current;
        if (!node) return;
        node.classList.remove("np-pop-open");
        this.opener?.setAttribute("aria-expanded", "false");
        this.current = this.opener = null;
        node.dispatchEvent(new Event("np-close"));
      },
      outside(path) {
        if (!this.current) return;
        if (path.includes(this.current) || (this.opener && path.includes(this.opener))) return;
        this.close();
      },
    };
    const popEl = (cls, label, ...kids) => el("div", { class: "np-pop " + cls, role: "dialog", "aria-label": label }, ...kids);
    // picker buttons keep the caret in the chat box
    const keepFocus = (b) => (b.addEventListener("mousedown", (e) => e.preventDefault()), b);

    // ---- emoji picker (with search by name; also picks reactions for a tray slot or a chat message)
    const emoji = (() => {
      let node, body, tabsEl, recentSec, recentGrid, searchIn, emptyEl, mode = null; // mode: null (insert), { slot } or { msg }
      let recent = [];
      const NAMES = E.names || {};
      chrome.storage.local.get("recentEmoji").then((r) => (recent = Array.isArray(r.recentEmoji) ? r.recentEmoji.slice(0, 16) : [])).catch(() => {});
      const btn = (e) =>
        keepFocus(el("button", { type: "button", class: "np-emo-btn np-emo", title: (NAMES[e] || "").split("|")[0] || e, "aria-label": e, "data-emoji": e, onclick: () => pick(e) }, e));
      function pick(e) {
        recent = [e, ...recent.filter((x) => x !== e)].slice(0, 16);
        chrome.storage.local.set({ recentEmoji: recent }).catch(() => {});
        if (mode?.slot !== undefined) {
          const slot = mode.slot;
          pops.close();
          reactions.replace(slot, e);
          return;
        }
        if (mode?.msg) {
          const mid = mode.msg;
          pops.close();
          msgReactions.toggle(mid, e, true);
          return;
        }
        insertAtCursor(e);
        fillRecent();
      }
      function fillRecent() {
        if (!recentGrid) return;
        recentGrid.replaceChildren(...recent.map(btn));
        recentSec.hidden = !recent.length || !!searchIn.value.trim();
      }
      // every word typed must start a word of the emoji's name or keywords (or be the emoji itself)
      const hay = (e) => " " + (NAMES[e] || "").replace(/\|/g, " ") + " ";
      function filter() {
        const q = searchIn.value.toLowerCase().replace(/\s+/g, " ").trim();
        const words = q ? q.split(" ") : [];
        const seen = new Set();
        let shown = 0;
        for (const sec of body.querySelectorAll(".np-emo-sec")) {
          if (sec.dataset.cat === "recent") continue;
          let n = 0;
          for (const b of sec.querySelectorAll(".np-emo-btn")) {
            const e = b.dataset.emoji;
            const ok = !q || (!seen.has(e) && (e === q || words.every((w) => hay(e).includes(" " + w))));
            b.hidden = !ok;
            if (ok) (n++, q && seen.add(e));
          }
          sec.hidden = !n;
          shown += n;
        }
        recentSec.hidden = !recent.length || !!q;
        tabsEl.hidden = !!q;
        emptyEl.hidden = shown > 0;
        node.classList.toggle("np-searching", !!q);
        body.scrollTop = 0;
      }
      const first = () => [...body.querySelectorAll('.np-emo-sec:not([data-cat="recent"]) .np-emo-btn')].find((b) => !b.hidden && !b.closest("[hidden]"));
      function build() {
        body = el("div", { class: "np-emo-body" });
        tabsEl = el("div", { class: "np-emo-tabs", role: "tablist" });
        const section = (id, label, list) => {
          const grid = el("div", { class: "np-emo-grid" }, ...list.map(btn));
          const sec = el("section", { class: "np-emo-sec", "data-cat": id }, el("div", { class: "np-emo-label" }, label), grid);
          return [sec, grid];
        };
        [recentSec, recentGrid] = section("recent", "Recently used", []);
        body.append(recentSec);
        const tab = (id, icon, label) =>
          keepFocus(
            el("button", {
              type: "button", class: "np-emo-tab np-emo", title: label, "aria-label": label,
              onclick: () => {
                const sec = body.querySelector(`[data-cat="${id}"]`);
                if (sec && !sec.hidden) body.scrollTop = sec.offsetTop - body.offsetTop;
              },
            }, icon),
          );
        tabsEl.append(tab("recent", "🕘", "Recently used"));
        for (const c of E.categories) {
          body.append(section(c.id, c.label, c.list)[0]);
          tabsEl.append(tab(c.id, c.icon, c.label));
        }
        emptyEl = el("div", { class: "np-emo-empty", role: "status" }, "No emoji found");
        emptyEl.hidden = true;
        body.append(emptyEl);
        searchIn = el("input", { class: "np-emo-search", type: "text", placeholder: "Search emoji", "aria-label": "Search emoji", autocomplete: "off", spellcheck: "false", maxlength: "40" });
        searchIn.addEventListener("input", filter);
        node = popEl("np-emoji-pop", "Emoji", el("div", { class: "np-emo-head" }, searchIn), tabsEl, body);
        node.addEventListener("np-close", () => {
          mode = null;
          node.classList.remove("np-replace", "np-for-msg");
          emojiBtn.classList.remove("np-on");
          reactBtn.classList.remove("np-on");
          if (searchIn.value) {
            searchIn.value = "";
            filter();
          }
        });
        panel.append(node);
      }
      function openAs(want, opener) {
        if (!node) build();
        fillRecent();
        if (pops.current === node && !want && !mode) return pops.close();
        pops.close();
        pops.open(node, opener);
        mode = want;
        node.classList.toggle("np-replace", mode?.slot !== undefined);
        node.classList.toggle("np-for-msg", !!mode?.msg);
        node.setAttribute("aria-label", mode ? "Pick a reaction" : "Emoji");
        if (mode?.slot !== undefined) reactBtn.classList.add("np-on");
        else if (!mode) emojiBtn.classList.add("np-on");
        body.scrollTop = 0;
        // picking a reaction for a message: start in the search box (there's no caret to keep)
        if (mode?.msg) setTimeout(() => pops.current === node && searchIn.focus(), 30);
      }
      return {
        get searchEl() {
          return searchIn || null;
        },
        // forSlot: pick a replacement for that 🎉 tray slot instead of typing the emoji
        toggle(forSlot = null) {
          openAs(forSlot === null ? null : { slot: forSlot }, forSlot === null ? emojiBtn : reactBtn);
        },
        // react to a chat message with any emoji
        forMessage(mid, opener) {
          openAs({ msg: mid }, opener);
        },
        // Enter in the search box: the first result
        pickFirst() {
          const b = node && first();
          if (b) pick(b.dataset.emoji);
        },
        // Esc in the search box: clear it first, close the picker on the next Esc
        clearSearch() {
          if (!searchIn?.value) return false;
          searchIn.value = "";
          filter();
          return true;
        },
      };
    })();

    // ---- 2.1: reply to a message, react to a message
    // Hovering a chat line (tap or long-press on touch) shows a small bar with Reply and React.
    // Both travel as ordinary encrypted chat lines: a reply is a message with a quote ("re"),
    // a reaction is { t: "mr", id, e, on }. The server can't tell them from any other message.
    const lineInfo = new WeakMap(); // .np-msg -> { mid, uid, s, g }
    let replyTo = null; // { id, uid, name, s, g } while the reply strip is up
    const msgNode = (mid) => (chatEl && mid ? [...chatEl.querySelectorAll(".np-msg[data-mid]")].find((n) => n.dataset.mid === mid) || null : null);
    const reply = (() => {
      let strip, label;
      function build() {
        label = el("div", { class: "np-replybar-txt" });
        strip = el(
          "div",
          { class: "np-replybar", role: "status" },
          svg(ICON.reply),
          label,
          el("button", { type: "button", class: "np-replybar-x", title: "Cancel reply (Esc)", "aria-label": "Cancel reply", onclick: () => (cancel(), input.focus()) }, svg(ICON.close)),
        );
        strip.hidden = true;
        return strip;
      }
      function start(node) {
        const info = lineInfo.get(node);
        if (!info) return;
        const name = nameOf(info.uid);
        edit.cancel();
        replyTo = { id: info.mid, uid: info.uid, name: info.uid === party.me ? cleanName(party.name) || null : party.profiles.get(info.uid)?.name || null, s: info.s, g: info.g, sp: info.sp };
        label.replaceChildren("Replying to ", el("b", {}, name), ": ", el("span", { class: "np-replybar-s" }, info.g ? "GIF" : info.sp ? "Spoiler" : info.s));
        strip.hidden = false;
        acts.hide();
        input.focus();
      }
      function cancel() {
        if (!replyTo && strip?.hidden !== false) return false;
        replyTo = null;
        if (strip) strip.hidden = true;
        return true;
      }
      return { build, start, cancel, get active() { return !!replyTo; } };
    })();

    // ---- 2.2: edit one of your messages (the text goes back into the chat box; Enter saves, Esc cancels)
    let editing = null; // { mid } while editing
    const edit = (() => {
      let strip;
      function build() {
        strip = el(
          "div",
          { class: "np-editbar", role: "status" },
          svg(ICON.edit),
          el("div", { class: "np-replybar-txt" }, el("b", {}, "Editing your message"), " · Enter saves"),
          el("button", { type: "button", class: "np-editbar-x", title: "Cancel editing (Esc)", "aria-label": "Cancel editing", onclick: () => (cancel(), input.focus()) }, svg(ICON.close)),
        );
        strip.hidden = true;
        return strip;
      }
      function start(node) {
        const info = lineInfo.get(node);
        if (!info || info.uid !== party.me || info.g || node.dataset.deleted) return;
        reply.cancel();
        if (spoilerOn) setSpoiler(false);
        editing = { mid: info.mid };
        strip.hidden = false;
        input.value = info.raw;
        input.setSelectionRange(input.value.length, input.value.length);
        lastSel = null;
        updateSend();
        acts.hide();
        input.focus();
      }
      function cancel() {
        if (!editing) return false;
        editing = null;
        strip.hidden = true;
        input.value = "";
        mention.close();
        updateSend();
        return true;
      }
      return { build, start, cancel };
    })();

    // ---- 2.2: @mentions. Typing "@" (then a few letters) lists the party's members; Enter, Tab or a click
    // puts "@Name " in the chat box. Names with spaces work: a mention is found by the member's whole name.
    const mention = (() => {
      let node = null, list = [], sel = 0, at = -1;
      function build() {
        node = el("div", { class: "np-mention-pop", role: "listbox", "aria-label": "Mention someone" });
        node.hidden = true;
        return node;
      }
      // the "@query" right before the caret, or null
      function query() {
        if (shadow?.activeElement !== input) return null;
        const v = input.value, c = input.selectionStart ?? v.length;
        if (input.selectionEnd !== c) return null;
        for (let i = c - 1; i >= 0 && c - i <= 25; i--) {
          if (v[i] === "@") {
            if (i > 0 && !/\s/.test(v[i - 1])) return null;
            return { at: i, q: v.slice(i + 1, c) };
          }
          if (v[i] === "\n") return null;
        }
        return null;
      }
      function update() {
        if (!node) return;
        const m = query();
        const q = m ? m.q.toLowerCase().replace(/\s+/g, " ") : null;
        list =
          q === null
            ? []
            : party.members
                .filter((x) => x.id !== party.me)
                .map((x) => ({ id: x.id, name: nameOf(x.id) }))
                .filter((x) => {
                  const n = x.name.toLowerCase();
                  return !q || n.startsWith(q) || n.split(" ").some((w) => w.startsWith(q));
                })
                .slice(0, 6);
        if (!list.length) return close();
        at = m.at;
        sel = Math.min(sel, list.length - 1);
        node.replaceChildren(
          ...list.map((x, i) =>
            keepFocus(
              el("button", {
                type: "button", class: "np-mention-opt" + (i === sel ? " np-on" : ""), role: "option", "aria-selected": String(i === sel), "data-pid": x.id,
                onclick: () => pick(i),
              }, paintPic(el("span", { class: "np-mention-av np-emo", style: `--h:${hue(x.id)}` }), x.id), el("span", { class: "np-mention-name" }, x.name)),
            ),
          ),
        );
        node.hidden = false;
      }
      function pick(i) {
        const x = list[i];
        if (!x) return;
        const c = input.selectionStart ?? input.value.length;
        const ins = "@" + x.name + " ";
        if (input.value.length - (c - at) + ins.length > 500) return close();
        input.setRangeText(ins, at, c, "end");
        lastSel = [input.selectionStart, input.selectionEnd];
        close();
        updateSend();
        input.focus();
      }
      function close() {
        list = [];
        sel = 0;
        if (node) node.hidden = true;
      }
      // keys while the list is open: arrows move, Enter / Tab pick, Esc closes
      function key(e) {
        if (!node || node.hidden || !list.length) return false;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          sel = (sel + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
          update();
          return true;
        }
        if (e.key === "Enter" && !e.shiftKey && query()?.q.toLowerCase() === list[sel]?.name.toLowerCase()) {
          close(); // the whole name is typed already: Enter sends
          return false;
        }
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
          e.preventDefault();
          pick(sel);
          return true;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          close();
          return true;
        }
        return false;
      }
      return { build, update, close, key, get open() { return !!node && !node.hidden; } };
    })();

    // ---- 2.2: the Spoiler switch in the composer (the whole message is hidden until tapped)
    let spoilerOn = false, spoilerBtn = null;
    function setSpoiler(on) {
      spoilerOn = !!on;
      if (!spoilerBtn) return;
      spoilerBtn.classList.toggle("np-on", spoilerOn);
      spoilerBtn.setAttribute("aria-pressed", String(spoilerOn));
      input.placeholder = spoilerOn ? "Spoiler message (hidden until tapped)…" : "Message the party…";
    }

    // reactions on chat lines: mid -> Map(emoji -> Set(pid)), for the lines still in the chat
    const msgReactions = (() => {
      const rx = new Map();
      const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
      let quick = null, quickMid = null;
      const mineOn = (mid, e) => !!rx.get(mid)?.get(e)?.has(party.me);
      // what a reaction from `from` does to the line it points at (ignored if that line isn't here)
      function apply({ from, id, e, on }, draw = true) {
        const node = msgNode(id);
        if (!node || node.dataset.deleted) return;
        let m = rx.get(id);
        if (!m) rx.set(id, (m = new Map()));
        let who = m.get(e);
        if (on) {
          if (!who) {
            if (m.size >= 16) return; // a sane number of different emoji per line
            m.set(e, (who = new Set()));
          }
          who.add(from);
        } else if (who) {
          who.delete(from);
          if (!who.size) m.delete(e);
        }
        if (draw) render(node);
      }
      const names = (set) => [...set].map((pid) => (pid === party.me ? "You" : nameOf(pid))).join(", ");
      function render(node) {
        const mid = node.dataset.mid;
        const m = rx.get(mid);
        const col = node.querySelector(".np-mcol");
        let row = col.querySelector(".np-reacts");
        if (!m || !m.size) return row?.remove();
        const visible = chatEl.clientHeight > 0;
        const nearBottom = visible ? chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60 : chatStick;
        if (!row) col.append((row = el("div", { class: "np-reacts" })));
        row.replaceChildren(
          ...[...m].map(([e, who]) => {
            const mine = who.has(party.me);
            const list = names(who);
            return el("button", {
              type: "button", class: "np-rchip" + (mine ? " np-rmine" : ""), "data-emoji": e, title: list + (mine ? " (tap to remove yours)" : ""),
              "aria-label": `${e} ${who.size}: ${list}`, "aria-pressed": String(mine), onclick: () => toggle(mid, e),
            }, el("span", { class: "np-emo" }, e), el("span", { class: "np-rn" }, String(who.size)));
          }),
        );
        if (nearBottom || !open) chatToBottom();
      }
      // send: on/off for my reaction (default: the opposite of what I have now)
      function toggle(mid, e, on = !mineOn(mid, e)) {
        if (!mid || !isSingleEmoji(e, 16)) return;
        if (on === mineOn(mid, e)) return;
        sendLine({ t: "mr", id: mid, e, on }).catch((err) => system("Reaction not sent: " + err.message));
      }
      function buildQuick() {
        quick = popEl(
          "np-qreact",
          "React to this message",
          el(
            "div",
            { class: "np-qreact-row" },
            ...QUICK.map((e) =>
              keepFocus(el("button", { type: "button", class: "np-qbtn np-emo", "data-emoji": e, title: "React " + e, "aria-label": "React " + e, onclick: () => (pops.close(), toggle(quickMid, e)) }, e)),
            ),
            keepFocus(el("button", { type: "button", class: "np-qbtn np-qmore", title: "More emoji", "aria-label": "More emoji", onclick: () => emoji.forMessage(quickMid, null) }, "+")),
          ),
        );
        panel.append(quick);
      }
      // the quick-pick row, just above the line it's for
      function openQuick(node, opener) {
        if (!quick) buildQuick();
        quickMid = node.dataset.mid;
        for (const b of quick.querySelectorAll(".np-qbtn[data-emoji]")) b.classList.toggle("np-rmine", mineOn(quickMid, b.dataset.emoji));
        // above the line, inside the chat area; below the line when there's no room above it
        const pr = panel.getBoundingClientRect(), nr = node.getBoundingClientRect(), cr = chatEl.getBoundingClientRect();
        const minTop = cr.top - pr.top + 4, maxTop = cr.bottom - pr.top - 54;
        let top = nr.top - pr.top - 54;
        if (top < minTop) top = Math.min(nr.bottom - pr.top + 6, maxTop);
        top = Math.max(8, Math.min(top, maxTop));
        if (pops.current === quick && quick.dataset.mid === quickMid) return pops.close();
        quick.dataset.mid = quickMid;
        pops.close();
        pops.open(quick, opener, Math.round(top));
      }
      return {
        apply,
        toggle,
        openQuick,
        forget: (mid) => rx.delete(mid),
        clear: () => rx.clear(),
        redraw() {
          if (chatEl) for (const n of chatEl.querySelectorAll(".np-msg[data-mid]")) if (rx.has(n.dataset.mid)) render(n);
        },
      };
    })();

    // the hover / tap bar (one, moved to the line it's for)
    const acts = (() => {
      let bar, on = null, pressT = 0, pinB, editB, delB, delT = 0;
      const lineOf = () => bar.closest(".np-msg");
      function build() {
        // 2.2: Pin (the host, or anyone while everyone controls playback), Edit and Delete (your own lines)
        pinB = el("button", { type: "button", class: "np-act np-act-pin", title: "Pin", "aria-label": "Pin", onclick: (e) => (e.stopPropagation(), pin.toggle(lineOf())) }, svg(ICON.pin));
        editB = el("button", { type: "button", class: "np-act np-act-edit", title: "Edit", "aria-label": "Edit", onclick: (e) => (e.stopPropagation(), edit.start(lineOf())) }, svg(ICON.edit));
        delB = el("button", {
          type: "button", class: "np-act np-act-del", title: "Delete", "aria-label": "Delete",
          onclick: (e) => {
            e.stopPropagation();
            // two steps: the first press asks, a second one within 3 seconds deletes
            if (!delB.classList.contains("np-act-confirm")) {
              delB.classList.add("np-act-confirm");
              delB.title = "Press again to delete";
              delB.setAttribute("aria-label", "Press again to delete");
              clearTimeout(delT);
              delT = setTimeout(resetDel, 3000);
              return;
            }
            resetDel();
            const info = lineInfo.get(lineOf());
            if (info && info.uid === party.me) sendLine({ t: "md", id: info.mid }).catch((err) => system("Not deleted: " + err.message));
          },
        }, svg(ICON.trash));
        bar = el(
          "div",
          { class: "np-acts", role: "toolbar", "aria-label": "Message actions" },
          el("button", { type: "button", class: "np-act np-act-reply", title: "Reply", "aria-label": "Reply", onclick: (e) => (e.stopPropagation(), reply.start(lineOf())) }, svg(ICON.reply)),
          el("button", {
            type: "button", class: "np-act np-act-react", title: "React", "aria-label": "React",
            onclick: (e) => (e.stopPropagation(), msgReactions.openQuick(lineOf(), e.currentTarget)),
          }, svg(ICON.smile)),
          pinB,
          editB,
          delB,
        );
        for (const b of bar.children) keepFocus(b);
        return bar;
      }
      function resetDel() {
        clearTimeout(delT);
        if (!delB) return;
        delB.classList.remove("np-act-confirm");
        delB.title = "Delete";
        delB.setAttribute("aria-label", "Delete");
      }
      // put the bar on a line (mouse: on hover; touch: on tap or long-press)
      function attach(node) {
        if (!node?.dataset.mid || !lineInfo.has(node) || node.dataset.deleted) return;
        if (!bar) build();
        const col = node.querySelector(".np-mcol");
        if (col && bar.parentNode !== col) {
          resetDel();
          col.append(bar);
        }
        const info = lineInfo.get(node);
        const mine = info.uid === party.me;
        editB.hidden = !mine || info.g;
        delB.hidden = !mine;
        pinB.hidden = !canControl();
        const pinned = pin.current?.id === info.mid;
        pinB.classList.toggle("np-on", pinned);
        pinB.title = pinned ? "Unpin" : "Pin";
        pinB.setAttribute("aria-label", pinB.title);
      }
      function show(node) {
        attach(node);
        if (on && on !== node) on.classList.remove("np-acts-on");
        on = node;
        node.classList.add("np-acts-on");
      }
      function hide() {
        on?.classList.remove("np-acts-on");
        on = null;
      }
      // a deleted line loses its bar
      const detach = (node) => {
        if (bar && node.contains(bar)) bar.remove();
        if (on === node) hide();
      };
      const skip = (t) => t.closest?.("a, .np-quote, .np-reacts, .np-acts, img.np-gif, .np-spoiler");
      function wire(chat) {
        chat.addEventListener("pointerover", (e) => {
          if (e.pointerType !== "mouse") return;
          const node = e.target.closest?.(".np-msg");
          if (node) attach(node);
        });
        chat.addEventListener("pointerdown", (e) => {
          clearTimeout(pressT);
          lastPointer = e.pointerType || "mouse";
          if (e.pointerType === "mouse") return;
          const node = e.target.closest?.(".np-msg");
          if (!node || skip(e.target)) return;
          pressT = setTimeout(() => ((pressT = 0), show(node), (node.dataset.pressed = "1")), 450);
        });
        for (const t of ["pointerup", "pointercancel", "pointerleave"]) chat.addEventListener(t, () => clearTimeout(pressT));
        chat.addEventListener("scroll", () => clearTimeout(pressT), { passive: true });
        chat.addEventListener("contextmenu", (e) => e.target.closest?.(".np-msg") && e.pointerType !== "mouse" && navigator.maxTouchPoints > 0 && e.preventDefault());
        // a tap on a line toggles its bar (touch has no hover)
        chat.addEventListener("click", (e) => {
          if (lastPointer === "mouse") return;
          const node = e.target.closest?.(".np-msg");
          if (node?.dataset.pressed) return void delete node.dataset.pressed;
          if (!node || skip(e.target)) return node ? undefined : hide();
          on === node ? hide() : show(node);
        });
      }
      return { wire, hide, detach };
    })();
    let lastPointer = "mouse";

    // ---- 2.2: one pinned message for the party, in a bar above the chat (click: jump to it; ×: unpin).
    // Encrypted { id, uid, name?, s | g | sp } kept by the server with the party, so people who join later see it.
    const pin = (() => {
      let cur = null; // { id, uid, name, s, g, sp, by }
      let bar, txt, x;
      function build() {
        txt = el("button", { type: "button", class: "np-pin-txt", title: "Show the pinned message", onclick: () => cur && jumpTo(cur.id, txt) });
        x = el("button", { type: "button", class: "np-pin-x", title: "Unpin", "aria-label": "Unpin the message", onclick: () => send(null) }, svg(ICON.close));
        const icon = svg(ICON.pin);
        icon.classList.add("np-pin-icon");
        bar = el("div", { class: "np-pinbar", role: "region", "aria-label": "Pinned message" }, icon, txt, x);
        bar.hidden = true;
        return bar;
      }
      function draw() {
        if (!bar) return;
        const node = cur && msgNode(cur.id);
        if (!cur || node?.dataset.deleted) return void (bar.hidden = true);
        const info = node && lineInfo.get(node);
        const what = info ? (info.g ? "GIF" : info.sp ? "Spoiler" : info.s) : cur.g ? "GIF" : cur.s;
        const sig = [cur.id, quoteName(cur), what, canControl()].join("|");
        if (sig === bar.dataset.sig && !bar.hidden) return;
        bar.dataset.sig = sig;
        txt.replaceChildren(el("b", { class: "np-pin-name" }, quoteName(cur)), el("span", { class: "np-pin-s" + ((info ? info.sp : cur.sp) ? " np-pin-sp" : "") }, what));
        txt.setAttribute("aria-label", `Pinned: ${quoteName(cur)}: ${what}`);
        x.hidden = !canControl();
        bar.hidden = false;
      }
      async function send(payload) {
        try {
          const ct = payload ? await e2e.seal("pin", party.me, payload) : null;
          await net.request("pin", { ct });
        } catch (e) {
          system(/Unknown type/.test(e.message) ? "Pinning needs an updated party server." : "Couldn't pin: " + e.message);
        }
      }
      return {
        build,
        draw,
        get current() {
          return cur;
        },
        set(p) {
          cur = p;
          draw();
        },
        toggle(node) {
          const info = lineInfo.get(node);
          if (!info || !canControl()) return;
          acts.hide();
          if (cur?.id === info.mid) return send(null);
          const name = info.uid === party.me ? cleanName(party.name) : party.profiles.get(info.uid)?.name;
          send({ id: info.mid, uid: info.uid, ...(name ? { name } : {}), ...(info.g ? { g: 1 } : info.sp ? { sp: 1, s: "Spoiler" } : { s: info.s }) });
        },
      };
    })();

    // ---- 🎉 reactions: tray of 5 (editable), floating emoji over the video for everyone
    const reactions = (() => {
      let list = E.reactions.slice();
      let node, row, editing = false;
      const sent = [];
      function draw() {
        if (!row) return;
        row.replaceChildren(
          ...list.map((e, i) =>
            el("button", {
              type: "button", class: "np-react-btn np-emo", "data-emoji": e,
              title: editing ? `Replace ${e}` : `React ${e}`, "aria-label": editing ? `Replace ${e}` : `React ${e}`,
              onclick: () => (editing ? emoji.toggle(i) : send(e)),
            }, e),
          ),
          el("button", {
            type: "button", class: "np-react-edit" + (editing ? " np-on" : ""), title: editing ? "Done" : "Change these reactions",
            "aria-label": editing ? "Done editing reactions" : "Change these reactions", "aria-pressed": String(editing),
            onclick: () => ((editing = !editing), draw()),
          }, editing ? "Done" : svg(ICON.edit)),
        );
      }
      // hover 🎉 to open the tray; it stays open while the pointer is on the button or the
      // tray, and closes shortly after it leaves both (unless it was opened by a click or
      // is being edited). Each click on an emoji sends that one emoji.
      let hoverTimer = 0, pinned = false;
      const cancelHide = () => (clearTimeout(hoverTimer), (hoverTimer = 0));
      const hoverOpen = () => {
        cancelHide();
        if (pops.current === node && node) return;
        if (pops.current) return; // another picker is open: don't steal it on hover
        editing = false;
        pinned = false;
        openTray();
      };
      const hoverLeave = () => {
        cancelHide();
        hoverTimer = setTimeout(() => {
          hoverTimer = 0;
          if (!pinned && !editing && node && pops.current === node) pops.close();
        }, 350);
      };
      function openTray() {
        if (!node) {
          row = el("div", { class: "np-react-row" });
          node = popEl("np-react-pop", "Reactions", row);
          node.addEventListener("np-close", () => (reactBtn.classList.remove("np-on"), (pinned = false), cancelHide()));
          node.addEventListener("pointerenter", cancelHide);
          node.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && hoverLeave());
          panel.append(node);
        }
        draw();
        if (pops.current !== node) pops.open(node, reactBtn);
        reactBtn.classList.add("np-on");
      }
      function send(e) {
        const now = Date.now();
        while (sent.length && now - sent[0] > 3000) sent.shift();
        if (sent.length >= 12) {
          // same limit as the server: 12 every 3 seconds
          row.animate([{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" }], 220);
          return;
        }
        sent.push(now);
        float(e);
        if (party.roomId) recap.react(e);
        if (party.me && e2e.ready && isSingleEmoji(e, 16))
          e2e
            .seal("react", party.me, { e })
            .then((ct) => net.request("react", { ct }))
            .catch(() => {});
      }
      return {
        set(v) {
          if (Array.isArray(v) && v.length === 5 && v.every((x) => typeof x === "string" && x && x.length <= 16)) list = v.slice();
          else list = E.reactions.slice();
          draw();
        },
        replace(i, e) {
          const next = list.slice();
          next[i] = e;
          list = next;
          draw();
          chrome.storage.sync.set({ reactions: next }).catch(() => {});
          pinned = true; // reopened after picking a replacement: stay open until clicked away
          openTray();
        },
        toggle() {
          cancelHide();
          // a click while hover already opened it pins it open instead of closing it
          if (pops.current === node && node) {
            if (!pinned) return void (pinned = true);
            return pops.close();
          }
          editing = false;
          pinned = true;
          openTray();
        },
        hoverOpen,
        hoverLeave,
      };
    })();

    // floating reaction: rises from the bottom of the video area with a little wobble
    function float(e) {
      if (!host) build();
      if (typeof e !== "string" || !e || e.length > 16 || !party.roomId) return;
      while (floatLayer.childElementCount > 40) floatLayer.firstElementChild.remove();
      const n = el("span", { class: "np-fly np-emo", "aria-hidden": "true" }, e);
      const right = Math.random() < 0.7;
      n.style.left = (right ? 62 + Math.random() * 28 : 6 + Math.random() * 24) + "%";
      floatLayer.append(n);
      const dur = 2600 + Math.random() * 900;
      const amp = 10 + Math.random() * 16, dir = Math.random() < 0.5 ? -1 : 1;
      const rise = Math.round(innerHeight * (0.55 + Math.random() * 0.2));
      const frames = [0, 0.15, 0.35, 0.55, 0.75, 1].map((t) => ({
        offset: t,
        transform: `translate(${Math.round(dir * amp * Math.sin(t * Math.PI * 3))}px, ${-Math.round(rise * t)}px) scale(${t < 0.15 ? 0.6 + t * 4 : 1.2 - t * 0.25})`,
        opacity: t === 0 ? 0 : t < 0.7 ? 1 : t === 1 ? 0 : 0.8,
      }));
      const a = n.animate(frames, { duration: dur, easing: "cubic-bezier(.3,.6,.5,1)", fill: "forwards" });
      a.onfinish = a.oncancel = () => n.remove();
      setTimeout(() => n.remove(), dur + 500); // in case animations are paused (background tab)
    }

    // ---- GIFs (KLIPY, through our server; the API key stays there)
    // search results: images only from KLIPY's media hosts (GIF_HOSTS)
    const gifUrlOk = (u) => {
      try {
        const x = new URL(u);
        return x.protocol === "https:" && GIF_HOSTS.includes(x.hostname);
      } catch {
        return false;
      }
    };
    // Images load straight from KLIPY. If the site's CSP blocks that, they're fetched by
    // the background worker and shown from a blob: URL instead (data: if blob: is blocked too).
    const media = (() => {
      let mode = "direct"; // -> "blob" -> "data" -> "none" as the page's CSP turns out stricter
      const blobs = new Set();
      async function viaBackground(img, url) {
        const r = await chrome.runtime.sendMessage({ cmd: "gifMedia", url }).catch(() => null);
        if (!r?.dataUrl || !img.isConnected) return false;
        if (mode === "blob") {
          // decode by hand: fetch("data:…") would be subject to the page's connect-src
          const [head, b64] = r.dataUrl.split(",");
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const b = URL.createObjectURL(new Blob([bytes], { type: (head.match(/^data:([^;,]+)/) || [])[1] || "image/gif" }));
          blobs.add(b);
          img.dataset.blob = b;
          img.src = b;
        } else img.src = r.dataUrl;
        return true;
      }
      function load(img, url) {
        img.decoding = "async";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.alt = img.alt || "GIF";
        let step = mode;
        const tryStep = () => {
          if (step === "direct") img.src = url;
          else if (step === "blob" || step === "data") {
            if (mode === "direct") mode = step;
            viaBackground(img, url).then((ok) => !ok && fail());
          } else img.classList.add("np-broken");
        };
        const fail = () => {
          const order = ["direct", "blob", "data", "none"];
          step = order[order.indexOf(step) + 1] || "none";
          if (["blob", "data", "none"].indexOf(step) > ["blob", "data", "none"].indexOf(mode)) mode = step;
          tryStep();
        };
        img.addEventListener("error", () => {
          if (img.dataset.blob) {
            URL.revokeObjectURL(img.dataset.blob);
            blobs.delete(img.dataset.blob);
            delete img.dataset.blob;
          }
          fail();
        });
        tryStep();
      }
      function release(rootNode) {
        for (const i of rootNode.querySelectorAll?.("img[data-blob]") || []) {
          URL.revokeObjectURL(i.dataset.blob);
          blobs.delete(i.dataset.blob);
        }
      }
      return { load, release, get mode() { return mode; } };
    })();

    const gif = (() => {
      let node, inputEl, chips, grid, statusEl, state = "unknown", next = "", query = "", seq = 0, loading = false, timer = 0, autoTitle = "";
      const api = (kind, q = "", pos = "") =>
        chrome.runtime.sendMessage({ cmd: "gifs", server: party.serverUrl, kind, q, pos }).catch(() => ({ status: 0, body: null }));
      function setState(s) {
        state = s;
        const off = s === "off";
        gifBtn.classList.toggle("np-disabled", off);
        gifBtn.setAttribute("aria-disabled", String(off));
        gifBtn.title = off ? "GIFs aren't available right now" : "Send a GIF";
      }
      async function probe() {
        const r = await api("trending");
        setState(r?.status === 200 ? "ok" : r?.status === 503 || r?.body?.error === "gifs_unavailable" ? "off" : state === "ok" ? "ok" : "off");
        return state;
      }
      function status(text) {
        statusEl.textContent = text || "";
        statusEl.hidden = !text;
      }
      function build() {
        inputEl = el("input", { class: "np-gif-input", type: "search", placeholder: "Search KLIPY", "aria-label": "Search GIFs", maxlength: "100", autocomplete: "off" });
        inputEl.addEventListener("input", () => {
          clearTimeout(timer);
          timer = setTimeout(searchNow, 350);
        });
        chips = el("div", { class: "np-chips" });
        grid = el("div", { class: "np-gif-grid" });
        statusEl = el("div", { class: "np-gif-status", role: "status" });
        const scroller = el("div", { class: "np-gif-scroll" }, grid, statusEl);
        scroller.addEventListener("scroll", () => {
          if (next && !loading && scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 120) more();
        });
        node = popEl("np-gif-pop", "GIFs", el("div", { class: "np-gif-head" }, inputEl), chips, scroller, el("div", { class: "np-klipy" }, "Powered by KLIPY"));
        node.addEventListener("np-close", () => gifBtn.classList.remove("np-on"));
        panel.append(node);
      }
      function drawChips() {
        const t = currentTitle();
        const words = [...new Set([t, "reaction", "lol", "omg", "popcorn"].filter(Boolean))];
        chips.replaceChildren(
          ...words.map((w) =>
            el("button", { type: "button", class: "np-chip" + (w === query ? " np-on" : ""), title: `GIFs for “${w}”`, onclick: () => ((inputEl.value = w), searchNow()) }, w),
          ),
        );
      }
      function addResults(list) {
        for (const r of list) {
          if (!gifUrlOk(r.url)) continue;
          const img = el("img", { class: "np-gif-thumb", alt: r.title || "GIF" });
          if (r.w && r.h) img.style.aspectRatio = `${r.w} / ${r.h}`;
          media.load(img, gifUrlOk(r.preview) ? r.preview : r.url);
          grid.append(el("button", { type: "button", class: "np-gif-cell", title: r.title || "Send this GIF", "aria-label": "Send GIF" + (r.title ? ": " + r.title : ""), onclick: () => sendGif(r) }, img));
        }
      }
      async function run(q, pos) {
        const my = ++seq;
        loading = true;
        if (!pos) status("Loading GIFs…");
        const r = await api(q ? "search" : "trending", q, pos);
        if (my !== seq) return;
        loading = false;
        if (r?.status !== 200 || !Array.isArray(r.body?.results)) {
          if (r?.status === 503) setState("off");
          if (!pos) grid.replaceChildren();
          status(r?.status === 503 ? "GIFs aren't available right now." : r?.status === 429 ? "Too many searches. Try again in a minute." : "Couldn't load GIFs. Try again.");
          return;
        }
        setState("ok");
        if (!pos) {
          media.release(grid);
          grid.replaceChildren();
        }
        addResults(r.body.results);
        next = r.body.next || "";
        status(grid.childElementCount ? "" : `No GIFs for “${q}”.`);
      }
      function searchNow() {
        clearTimeout(timer);
        query = inputEl.value.replace(/\s+/g, " ").trim().slice(0, 100);
        next = "";
        drawChips();
        grid.parentElement.scrollTop = 0;
        run(query, "");
      }
      const more = () => run(query, next);
      function sendGif(r) {
        pops.close();
        if (!isKlipyMediaUrl(r.url)) return system("GIF not sent: not a KLIPY image.");
        sendLine({ t: "gif", url: r.url, w: dim(r.w) || undefined, h: dim(r.h) || undefined }).catch((e) => system("GIF not sent: " + e.message));
        input.focus();
      }
      return {
        get inputEl() {
          return inputEl;
        },
        probe,
        searchNow: () => node && searchNow(),
        async toggle() {
          if (!node) build();
          if (pops.current === node) return pops.close();
          pops.open(node, gifBtn);
          gifBtn.classList.add("np-on");
          if (state !== "ok") await probe(); // e.g. the server got its KLIPY key since
          if (pops.current !== node) return;
          if (state === "off") {
            grid.replaceChildren();
            chips.replaceChildren();
            inputEl.disabled = true;
            return status("GIFs aren't available right now.");
          }
          inputEl.disabled = false;
          // suggest GIFs for what's on screen (and follow it to the next title)
          const t = currentTitle();
          if (t && (!inputEl.value || inputEl.value === autoTitle) && t !== inputEl.value) {
            inputEl.value = autoTitle = t;
          }
          if (!grid.childElementCount || inputEl.value.replace(/\s+/g, " ").trim() !== query) searchNow();
          else drawChips();
          setTimeout(() => inputEl.focus(), 30);
        },
      };
    })();

    // ---- your profile: name + picture (also in the popup)
    // 2.2 "Upload photo": centre-cropped to a square, 96 x 96, WebP (JPEG where the browser can't
    // encode WebP) at the best quality that fits 9 KB, as a data: URL. Decoded and drawn by the
    // browser locally; it only ever leaves inside the encrypted profile.
    const PHOTO_PX = 96, PHOTO_BYTES = 9000;
    async function makePhoto(file) {
      if (!file || !/^image\//.test(file.type || "") || file.size > 25e6) throw new Error("Pick an image file.");
      let bmp;
      try {
        bmp = await createImageBitmap(file);
      } catch {
        throw new Error("Couldn't open that picture. Try a JPEG or PNG.");
      }
      const side = Math.min(bmp.width, bmp.height);
      const draw = (fill) => {
        const c = document.createElement("canvas");
        c.width = c.height = PHOTO_PX;
        const g = c.getContext("2d");
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = "high";
        if (fill) (g.fillStyle = "#26232f"), g.fillRect(0, 0, PHOTO_PX, PHOTO_PX); // JPEG has no transparency
        g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, PHOTO_PX, PHOTO_PX);
        return c;
      };
      try {
        for (const type of ["image/webp", "image/jpeg"]) {
          const c = draw(type === "image/jpeg");
          for (const q of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.4, 0.3]) {
            const b = await new Promise((r) => c.toBlob(r, type, q));
            if (!b || b.type !== type) break; // can't encode this type here
            if (b.size > PHOTO_BYTES) continue;
            const url = await new Promise((r, j) => {
              const fr = new FileReader();
              fr.onload = () => r(fr.result);
              fr.onerror = j;
              fr.readAsDataURL(b);
            });
            if (cleanImg(url)) return url;
            break;
          }
        }
      } finally {
        bmp.close?.();
      }
      throw new Error("Couldn't make a small enough picture from that file.");
    }

    const avatarPicker = (() => {
      let node, nameIn, fileIn, removeBtn, upBtn;
      // pick an HD picture or an emoji (replaces your photo, if you had one)
      function choose(a) {
        pops.close();
        party.avatar = a; // the storage listeners send the new profile to the party
        chrome.storage.sync.set({ avatar: a }).catch(() => {});
        if (party.photo) {
          party.photo = null;
          chrome.storage.local.remove("avatarPhoto").catch(() => {});
        }
        peopleSig = "";
        render();
        refreshNames();
      }
      async function upload(file) {
        try {
          const url = await makePhoto(file);
          party.photo = url;
          await chrome.storage.local.set({ avatarPhoto: url }); // this browser only (sync items are capped at 8 KB)
          pops.close();
            peopleSig = "";
          render();
          refreshNames();
        } catch (e) {
          system(e?.message || "Couldn't use that picture.");
        }
      }
      function removePhoto() {
        pops.close();
        party.photo = null;
        chrome.storage.local.remove("avatarPhoto").catch(() => {});
        peopleSig = "";
        render();
        refreshNames();
      }
      function marks() {
        for (const b of node.querySelectorAll(".np-avatar-opt")) b.classList.toggle("np-on", !party.photo && b.dataset.avatar === party.avatar);
        removeBtn.hidden = !party.photo;
        upBtn.classList.toggle("np-on", !!party.photo);
        paintPic(upBtn.querySelector(".np-up-pic"), party.me || "?");
      }
      // same as the popup: the saved name, or empty (placeholder) while it's an automatic "Guest N"
      const shownName = () => {
        const n = cleanName(party.name);
        return n && !/^Guest \d+$/.test(n) ? n : "";
      };
      // like the popup's saveName: empty input is ignored, otherwise chrome.storage.sync { name }
      // (the storage listener sends the new profile to the party)
      function saveName() {
        if (!nameIn) return;
        const v = cleanName(nameIn.value);
        if (!v) {
          nameIn.value = shownName();
          return;
        }
        if (nameIn.value !== v) nameIn.value = v;
        if (v === cleanName(party.name)) return;
        party.name = v;
        chrome.storage.sync.set({ name: v }).catch(() => {});
        refreshNames();
        peopleSig = "";
        render();
      }
      return {
        get nameInput() {
          return nameIn;
        },
        saveName,
        revert() {
          if (nameIn) nameIn.value = shownName();
        },
        toggle(anchor, focusName = false) {
          if (!node) {
            nameIn = el("input", {
              class: "np-name-input", type: "text", maxlength: "24", autocomplete: "off", spellcheck: "false",
              placeholder: "Your name (what friends see)", "aria-label": "Your name",
            });
            nameIn.addEventListener("blur", saveName);
            node = popEl(
              "np-avatar-pop",
              "Your profile",
              el("div", { class: "np-pop-title" }, "Your profile"),
              el("label", { class: "np-field" }, el("span", { class: "np-field-label" }, "Name"), nameIn),
              el("div", { class: "np-field-label np-field-sub" }, "Picture"),
              el(
                "div",
                { class: "np-avatar-scroll" },
                el(
                  "div",
                  { class: "np-photo-row" },
                  (upBtn = el(
                    "button",
                    { type: "button", class: "np-photo-btn", title: "Use a photo of your own (only people in your party see it)", onclick: () => fileIn.click() },
                    el("span", { class: "np-up-pic np-emo" }),
                    el("span", {}, "Upload photo"),
                  )),
                  (removeBtn = el("button", { type: "button", class: "np-photo-btn np-photo-remove", onclick: removePhoto }, "Remove photo")),
                  (fileIn = el("input", { type: "file", accept: "image/*", hidden: "", "aria-hidden": "true", tabindex: "-1" })),
                ),
                el(
                  "div",
                  { class: "np-avatar-grid np-hd-grid" },
                  ...[...HD.values()].map((x) =>
                    el(
                      "button",
                      { type: "button", class: "np-avatar-opt np-avatar-hd np-emo", title: x.label, "aria-label": "Use " + x.label, "data-avatar": "av:" + x.id, onclick: () => choose("av:" + x.id) },
                      paintSpec(el("span", { class: "np-opt-pic" }), { e: x.emoji, hd: "av:" + x.id, img: null }),
                    ),
                  ),
                ),
                el("div", { class: "np-field-label np-field-sub" }, "Emoji"),
                el(
                  "div",
                  { class: "np-avatar-grid" },
                  ...E.avatars.map((a) =>
                    el("button", { type: "button", class: "np-avatar-opt np-emo", title: a, "aria-label": "Use " + a, "data-avatar": a, onclick: () => choose(a) }, a),
                  ),
                ),
              ),
            );
            fileIn.addEventListener("change", () => {
              const f = fileIn.files?.[0];
              fileIn.value = "";
              if (f) upload(f);
            });
            panel.append(node);
          }
          if (pops.current !== node) nameIn.value = shownName();
          marks();
          pops.open(node, anchor, 0);
          if (pops.current !== node) return;
          // just below what opened it (your picture in the people row, or your camera tile)
          const pr = panel.getBoundingClientRect(), ar = anchor?.getBoundingClientRect();
          let top = ar && panel.contains(anchor) ? ar.bottom - pr.top + 6 : headEl.offsetHeight + 4;
          top = Math.max(8, Math.min(top, panel.clientHeight - node.offsetHeight - 8));
          node.style.top = Math.round(top) + "px";
          if (focusName) nameIn.focus();
        },
      };
    })();

    // ---- theme: "light" / "dark", or null to follow the system (prefers-color-scheme, in overlay.css)
    let theme = null;
    function setTheme(t) {
      theme = t === "light" || t === "dark" ? t : null;
      if (!root) return;
      if (theme) root.dataset.theme = theme;
      else delete root.dataset.theme;
    }

    // ---- chat text size
    const FONTS = { s: [12, "Small"], m: [14, "Medium"], l: [16, "Large"] };
    let font = "m";
    function setFont(f) {
      font = FONTS[f] ? f : "m";
      if (!root) return;
      root.style.setProperty("--np-fs", FONTS[font][0] + "px");
      root.dataset.font = font;
      fontBtn.title = `Chat text size: ${FONTS[font][1]} (click to change)`;
      fontBtn.setAttribute("aria-label", fontBtn.title);
      camUi.relayout();
    }
    const cycleFont = () => {
      const next = { s: "m", m: "l", l: "s" }[font];
      setFont(next);
      chrome.storage.sync.set({ chatFont: next }).catch(() => {});
    };

    // ---- links in chat: real <a> nodes built from text (never innerHTML with user text)
    const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
    function linkify(text) {
      const out = [];
      let last = 0;
      for (const m of text.matchAll(URL_RE)) {
        let raw = m[0];
        // trailing punctuation belongs to the sentence, not the link (keep balanced brackets)
        for (;;) {
          const ch = raw.at(-1);
          if (/[.,!?;:'"*]/.test(ch)) raw = raw.slice(0, -1);
          else if (ch === ")" && (raw.match(/\)/g) || []).length > (raw.match(/\(/g) || []).length) raw = raw.slice(0, -1);
          else if (ch === "]" && (raw.match(/\]/g) || []).length > (raw.match(/\[/g) || []).length) raw = raw.slice(0, -1);
          else break;
        }
        let href = null;
        try {
          const u = new URL(/^www\./i.test(raw) ? "https://" + raw : raw);
          if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".")) href = u.href;
        } catch {}
        if (!href || raw.length < 5) continue;
        if (m.index > last) out.push(text.slice(last, m.index));
        out.push(el("a", { class: "np-a", href, target: "_blank", rel: "noopener noreferrer nofollow", title: href }, raw));
        last = m.index + raw.length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    }

    // ---- camera tiles. Docked (the default): inside the chat panel, a 16:9 grid as big as the
    // panel allows while the chat keeps ~4 lines + the composer (the panel's other chrome gets
    // compact, .np-camdock). Popped out: a floating window over the page, dragged by its bar
    // (anywhere, also over the chat), resized from any edge or corner (tiles stay 16:9), collapsible.
    // While the chat panel is closed, docked cameras float in that window's place (dock = open the chat).
    // Docked/popped, position, width and collapsed are kept per tab in sessionStorage "netpartyCams".
    const camUi = (() => {
      let body, countEl, collapseBtn, modeBtn, moveBtn, camIcon, bar, grip;
      const tiles = new Map(); // id -> { node, video, track, label, nameEl, pic, mic }
      const GAP = 4, MIN_W = 240, DEF_W = 440, STEP = 24;
      let mode = "dock", pos = null, fw = null, collapsed = false;
      let count = 0, where = null, raf = 0;
      try {
        const saved = JSON.parse(sessionStorage.getItem("netpartyCams") || "null");
        if (saved && typeof saved === "object") {
          collapsed = !!saved.collapsed;
          if (saved.mode === "float") mode = "float";
          if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) pos = { x: saved.x, y: saved.y };
          if (Number.isFinite(saved.w) && saved.w >= MIN_W) fw = Math.round(saved.w);
        }
      } catch {}
      const save = () => sessionStorage.setItem("netpartyCams", JSON.stringify({ mode, collapsed, ...(pos || {}), ...(fw ? { w: fw } : {}) }));
      const effective = () => (mode === "dock" && open ? "dock" : "float");
      const floating = () => where === "float";
      // the biggest 16:9 tiles for n cameras in a W×H box
      function fit(n, W, H) {
        let best = { cols: 1, tw: 0 };
        for (let cols = 1; cols <= n; cols++) {
          const rows = Math.ceil(n / cols);
          const tw = Math.floor(Math.min((W - GAP * (cols - 1)) / cols, ((H - GAP * (rows - 1)) / rows) * (16 / 9)));
          if (tw > best.tw + 1) best = { cols, tw };
        }
        return best;
      }
      // keep the floating window on screen; it may sit over the video or over the docked chat
      function clamp() {
        if (!floating() || camLayer.hidden) return;
        const r = camLayer.getBoundingClientRect();
        if (!pos) pos = { x: 16, y: innerHeight - r.height - 96 };
        pos.x = Math.round(Math.max(4, Math.min(pos.x, innerWidth - r.width - 4)));
        pos.y = Math.round(Math.max(4, Math.min(pos.y, innerHeight - r.height - 4)));
        camLayer.style.left = pos.x + "px";
        camLayer.style.top = pos.y + "px";
        camLayer.style.bottom = "auto";
      }
      function layout() {
        if (!camLayer || camLayer.hidden || !count) return;
        if (!floating()) {
          camLayer.style.cssText = "";
          if (collapsed || !panel.clientHeight) return;
          const ph = panel.clientHeight;
          let chrome = 0;
          for (const n of panel.children) if (n !== chatEl && n !== camLayer && !n.classList.contains("np-pop")) chrome += n.offsetHeight;
          const minChat = Math.round(4 * FONTS[font][0] * 1.45 + 24); // ~4 lines of chat stay visible
          const extra = camLayer.offsetHeight - body.offsetHeight; // the bar + padding
          const H = Math.max(80, Math.min(ph * 0.62, ph - chrome - minChat) - extra);
          body.style.setProperty("--tw", fit(count, body.clientWidth, H).tw + "px");
          return;
        }
        // floating: one tile, or two per row; the height follows the width (16:9 tiles)
        const cols = count > 1 ? 2 : 1, rows = Math.ceil(count / cols);
        camLayer.style.width = (fw || DEF_W) + "px";
        const frame = camLayer.offsetWidth - body.clientWidth; // padding + border
        const fixedH = camLayer.offsetHeight - (collapsed ? 0 : body.offsetHeight);
        const maxTw = ((innerHeight - 8 - fixedH - GAP * (rows - 1)) / rows) * (16 / 9);
        const maxW = Math.min(innerWidth - 8, cols * maxTw + GAP * (cols - 1) + frame);
        const w = Math.round(Math.max(Math.min(MIN_W, maxW), Math.min(fw || DEF_W, maxW)));
        camLayer.style.width = w + "px";
        body.style.setProperty("--tw", Math.floor((w - frame - GAP * (cols - 1)) / cols) + "px");
        clamp();
      }
      // (window resizes, panel size, text size; changes we make ourselves lay out right away,
      // so a background tab where animation frames wait still gets the right layout)
      const relayout = () => {
        if (!raf)
          raf = requestAnimationFrame(() => {
            raf = 0;
            layout();
          });
      };
      function labels() {
        const dock = !floating();
        modeBtn.replaceChildren(svg(dock ? ICON.popout : ICON.dockIn));
        modeBtn.title = dock ? "Pop out cameras" : open ? "Dock cameras in the chat" : "Dock cameras in the chat (opens the chat)";
        modeBtn.setAttribute("aria-label", modeBtn.title);
        collapseBtn.setAttribute("aria-expanded", String(!collapsed));
        collapseBtn.title = collapsed ? "Show cameras" : "Hide cameras";
        collapseBtn.setAttribute("aria-label", collapseBtn.title);
        bar.title = dock ? "" : "Drag to move";
      }
      // docked in the panel, or floating in the overlay's root (moving keeps the same video elements)
      function place() {
        const w = effective();
        panel.classList.toggle("np-camdock", count > 0 && w === "dock");
        if (w === where) return;
        const hadFocus = camLayer.contains(shadow.activeElement) ? shadow.activeElement : null;
        where = w;
        if (w === "dock") panel.insertBefore(camLayer, chatEl);
        else root.insertBefore(camLayer, toggleBtn);
        camLayer.classList.toggle("np-cams-float", w === "float");
        camLayer.classList.toggle("np-cams-docked", w === "dock");
        camLayer.setAttribute("aria-label", w === "dock" ? "Cameras" : "Cameras (floating window)");
        camLayer.style.cssText = "";
        for (const t of tiles.values()) if (t.video.srcObject) t.video.play().catch(() => {});
        labels();
        hadFocus?.focus({ preventScroll: true });
      }
      function setCollapsed(v) {
        collapsed = v;
        camLayer.classList.toggle("np-cams-min", collapsed);
        labels();
        save();
        layout();
      }
      function toggleMode() {
        collapsed = false;
        camLayer.classList.remove("np-cams-min");
        if (floating() && mode === "dock") {
          // docked, but floating because the chat is closed: open the chat
          save();
          show();
          modeBtn.focus({ preventScroll: true });
          return;
        }
        mode = floating() ? "dock" : "float";
        save();
        render();
        modeBtn.focus({ preventScroll: true });
      }
      function init() {
        countEl = el("span", { class: "np-cams-count" });
        camIcon = svg(ICON.cam);
        moveBtn = el("button", { type: "button", class: "np-cams-btn np-cams-move", title: "Move (drag, or arrow keys)", "aria-label": "Move the cameras window (arrow keys)" }, svg(ICON.grip));
        collapseBtn = el("button", { type: "button", class: "np-cams-btn np-cams-collapse", onclick: () => setCollapsed(!collapsed) }, svg(ICON.chevron));
        modeBtn = el("button", { type: "button", class: "np-cams-btn np-cams-mode", onclick: toggleMode });
        bar = el("div", { class: "np-cams-bar" }, moveBtn, camIcon, countEl, el("span", { class: "np-grow" }), collapseBtn, modeBtn);
        body = el("div", { class: "np-cams-body" });
        grip = el("button", { type: "button", class: "np-cams-grip", title: "Resize (drag, or arrow keys)", "aria-label": "Resize the cameras window (arrow keys)" }, svg(ICON.resize));
        // invisible resize edges all round the floating window (the corner grip stays, for keyboards too)
        const edges = ["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((d) => el("div", { class: "np-cams-edge np-cams-edge-" + d, "data-dir": d, "aria-hidden": "true" }));
        camLayer = el("div", { class: "np-cams np-cams-float", role: "region", "aria-label": "Cameras", hidden: "" }, bar, body, grip, ...edges);
        where = "float";
        // drag the floating window by its bar
        let drag = null;
        bar.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || !floating() || (e.target.closest("button") && !e.target.closest(".np-cams-move"))) return;
          const r = camLayer.getBoundingClientRect();
          drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
          bar.setPointerCapture(e.pointerId);
          camLayer.classList.add("np-dragging");
          e.preventDefault();
        });
        bar.addEventListener("pointermove", (e) => {
          if (!drag || e.pointerId !== drag.id) return;
          pos = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
          clamp();
        });
        const end = (e) => {
          if (!drag || e.pointerId !== drag.id) return;
          drag = null;
          camLayer.classList.remove("np-dragging");
          save();
        };
        bar.addEventListener("pointerup", end);
        bar.addEventListener("pointercancel", end);
        // resize from any edge or corner: the width changes and the height follows (tiles stay 16:9);
        // the opposite edge or corner stays where it was
        let rs = null;
        const rsStart = (e, dir, handle) => {
          if (e.button !== 0 || !floating() || collapsed) return;
          const r = camLayer.getBoundingClientRect();
          rs = { x: e.clientX, y: e.clientY, w: r.width, k: r.width / r.height, l: r.left, t: r.top, r: r.right, b: r.bottom, dir, id: e.pointerId, handle };
          handle.setPointerCapture(e.pointerId);
          camLayer.classList.add("np-resizing");
          e.preventDefault();
        };
        const rsMove = (e) => {
          if (!rs || e.pointerId !== rs.id) return;
          const d = rs.dir;
          const dx = (d.includes("e") ? 1 : d.includes("w") ? -1 : 0) * (e.clientX - rs.x);
          const dy = (d.includes("s") ? 1 : d.includes("n") ? -1 : 0) * (e.clientY - rs.y) * rs.k;
          const grow = !d.match(/[ns]/) ? dx : !d.match(/[ew]/) ? dy : Math.abs(dx) >= Math.abs(dy) ? dx : dy;
          fw = Math.round(Math.max(MIN_W, rs.w + grow));
          layout();
          const r = camLayer.getBoundingClientRect();
          pos = { x: d.includes("w") ? rs.r - r.width : rs.l, y: d.includes("n") ? rs.b - r.height : rs.t };
          clamp();
        };
        const rsEnd = (e) => {
          if (!rs || e.pointerId !== rs.id) return;
          rs = null;
          camLayer.classList.remove("np-resizing");
          fw = Math.round(camLayer.getBoundingClientRect().width); // what it settled at on this screen
          save();
        };
        for (const h of [grip, ...edges]) {
          h.addEventListener("pointerdown", (e) => rsStart(e, h === grip ? "se" : h.dataset.dir, h));
          h.addEventListener("pointermove", rsMove);
          h.addEventListener("pointerup", rsEnd);
          h.addEventListener("pointercancel", rsEnd);
        }
        // clicks and drags on the tiles must not reach the player (pause, seek, fullscreen)
        for (const evt of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel", "contextmenu"]) camLayer.addEventListener(evt, (e) => e.stopPropagation());
        addEventListener("resize", relayout);
        new ResizeObserver(relayout).observe(panel);
        setCollapsed(collapsed);
        return camLayer;
      }
      // arrow keys on the move / resize handles (keys reach us through early.js, never the site)
      function key(e) {
        const a = shadow.activeElement;
        if (!camLayer || !a || !camLayer.contains(a)) return false;
        if (e.key === "Escape") return floating(); // don't close the chat from the floating window
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!d || !floating() || (a !== moveBtn && a !== grip)) return false;
        e.preventDefault();
        const step = e.shiftKey ? STEP * 4 : STEP;
        if (a === moveBtn) {
          const r = camLayer.getBoundingClientRect();
          pos = { x: r.left + d[0] * step, y: r.top + d[1] * step };
          clamp();
        } else {
          fw = Math.max(MIN_W, Math.round(camLayer.getBoundingClientRect().width + (d[0] || d[1]) * step));
          layout();
          fw = Math.round(camLayer.getBoundingClientRect().width);
        }
        save();
        return true;
      }
      function tile(id, self) {
        const video = el("video", { class: "np-cam-video" + (self ? " np-self" : ""), autoplay: "", playsinline: "", "aria-hidden": "true" });
        video.muted = true; // voices play through the voice chat's own audio
        const pic = el("div", { class: "np-cam-pic np-emo", "aria-hidden": "true" });
        const nameEl = el("span", { class: "np-cam-label" });
        const mic = svg(ICON.micOff);
        mic.classList.add("np-cam-mic");
        // your own tile's name opens "Your profile" (the people row may be compacted away)
        const label = self
          ? el("button", { type: "button", class: "np-cam-name np-cam-me", title: "Change your name and picture", "aria-label": "Change your name and picture", onclick: (e) => openProfile(e.currentTarget, e.detail === 0) }, mic, nameEl, svg(ICON.edit))
          : el("div", { class: "np-cam-name" }, mic, nameEl);
        const node = el("div", { class: "np-cam", "data-uid": id }, pic, video, label);
        return { node, video, pic, label, nameEl, mic, track: null };
      }
      function render() {
        if (!camLayer) return;
        const list = [];
        if (voice.camOn && voice.camTrack) list.push({ id: party.me, track: voice.camTrack, live: true, self: true });
        list.push(...voice.cams());
        const want = new Set(list.map((c) => c.id));
        for (const [id, t] of tiles)
          if (!want.has(id)) {
            t.video.srcObject = null;
            t.node.remove();
            tiles.delete(id);
          }
        count = list.length;
        camLayer.hidden = !count;
        place();
        if (!count) return;
        for (const c of list) {
          let t = tiles.get(c.id);
          if (!t) tiles.set(c.id, (t = tile(c.id, c.self)));
          if (t.track !== c.track) {
            t.track = c.track;
            t.video.srcObject = new MediaStream([c.track]);
            t.video.play().catch(() => {});
          }
          t.node.classList.toggle("np-cam-wait", !c.live);
          const name = c.self ? "You" : nameOf(c.id);
          if (t.nameEl.textContent !== name) t.nameEl.textContent = name;
          paintPic(t.pic, c.id);
          t.pic.style.setProperty("--h", hue(c.id));
          const info = c.self ? { muted: voice.muted, speaking: voice.speaking } : voice.peerInfo(c.id);
          t.node.classList.toggle("np-speaking", !!info.speaking && !info.muted);
          t.node.classList.toggle("np-cam-muted", !!info.muted);
          t.node.title = c.live ? name : name + " · connecting video…";
        }
        // you first, then everyone else (only re-appended when the order changed)
        const order = list.map((c) => tiles.get(c.id).node);
        if (order.length !== body.childElementCount || order.some((n, i) => body.children[i] !== n)) body.append(...order);
        countEl.textContent = count === 1 ? "1 camera" : count + " cameras";
        layout();
      }
      return {
        init,
        render,
        key,
        relayout,
        get floating() {
          return floating();
        },
      };
    })();
    // "Your profile" from your camera tile: it lives in the chat panel, so open the chat first
    function openProfile(anchor, focusName) {
      if (!open) {
        show();
        setTimeout(() => avatarPicker.toggle(camLayer.contains(anchor) && panel.contains(anchor) ? anchor : peopleEl.querySelector(".np-me"), true), 60);
        return;
      }
      avatarPicker.toggle(anchor, focusName);
    }

    // Inter (SIL OFL, fonts/OFL.txt) under our own family name, so it never clashes with the site's fonts.
    // @font-face is ignored inside a shadow root, so it goes in the document's font set; the bytes are read
    // by the extension itself, so the site's font-src CSP doesn't apply. Until it loads (or if it can't),
    // the panel uses the system font.
    let fontLoaded = false;
    function loadFont() {
      if (fontLoaded) return;
      fontLoaded = true;
      fetch(chrome.runtime.getURL("fonts/inter-var.woff2"))
        .then((r) => r.arrayBuffer())
        .then((buf) => new FontFace("NetParty Inter", buf, { weight: "100 900", style: "normal" }).load())
        .then((face) => document.fonts.add(face))
        .catch(() => {});
    }

    function build() {
      host = el("div", { id: "netparty-root" });
      shadow = host.attachShadow({ mode: "open" });
      shadow.append(el("link", { rel: "stylesheet", href: chrome.runtime.getURL("overlay.css") }));
      loadFont();

      badge = el("span", { class: "np-badge" });
      toggleBtn = el("button", { type: "button", class: "np-toggle", title: "Party chat (NetParty)", "aria-label": "Party chat (NetParty)", onclick: () => (open ? hide() : show()) }, svg(ICON.chat), badge);
      toastEl = el("div", { class: "np-toast", onclick: show });
      floatLayer = el("div", { class: "np-float", "aria-hidden": "true" });

      codeEl = el("span", { class: "np-code" });
      metaEl = el("div", { class: "np-meta" });
      // 2.3: Invite opens the share block (copy link, WhatsApp, Discord, Instagram, QR code)
      const copyBtn = el(
        "button",
        { type: "button", class: "np-pill np-invite", title: "Invite friends: copy the link, send it to an app, or show a QR code", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: (e) => share.toggle(e.currentTarget) },
        svg(ICON.link),
        el("span", {}, "Invite"),
      );
      // 2.3: the party recap so far (also offered when the party ends)
      const recapBtn = el(
        "button",
        {
          type: "button", class: "np-pill np-pill-soft np-recap-btn", title: "Your party recap: a picture of tonight to share",
          onclick: () => {
            const snap = recap.current();
            if (snap) recapView.open(snap);
          },
        },
        svg(ICON.sparkle),
        el("span", {}, "Recap"),
      );
      // the host gets a choice: hand the party to someone (it carries on), or end it for everyone
      const leaveClick = (e) => {
        const isHost = party.me === party.hostId;
        if (isHost && party.members.some((m) => m.id !== party.me && !m.away)) return leaveMenu.toggle(e.currentTarget);
        if (confirm(isHost ? "End the party for everyone?" : "Leave this party?")) leaveParty({ end: true });
      };
      // compact header (while cameras are docked): Invite and Leave party as icon buttons
      const copyIcon = el("button", {
        type: "button", class: "np-icon np-head-act np-copy-icon", title: "Invite friends", "aria-label": "Invite friends", "aria-haspopup": "dialog",
        onclick: (e) => share.toggle(e.currentTarget),
      }, svg(ICON.link));
      leaveIcon = el("button", { type: "button", class: "np-icon np-head-act np-leave-icon", title: "Leave party", "aria-label": "Leave party", onclick: leaveClick }, svg(ICON.leave));
      const head = (headEl = el(
        "div",
        { class: "np-head" },
        el("div", { class: "np-title" }, el("div", { class: "np-brand" }, "NetParty ", codeEl), metaEl),
        el("div", { class: "np-head-acts" }, copyIcon, leaveIcon),
        iconBtn(ICON.close, "Hide chat (Esc)", hide, "np-close"),
      ));

      peopleEl = el("div", { class: "np-people" });
      voiceBox = el("div", { class: "np-voice" });
      chatEl = el("div", { class: "np-chat", role: "log", "aria-live": "polite" });
      acts.wire(chatEl);
      // Remember where the reader is while the chat is visible. A hidden chat (panel closed, page
      // navigation, a picker or dock change) loses its scroll position, so when it gets a size
      // again it goes back to the newest message, or to where they had scrolled up to.
      chatEl.addEventListener("scroll", () => {
        if (!chatEl.clientHeight) return;
        chatStick = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
        chatSaved = chatEl.scrollTop;
      }, { passive: true });
      let chatH = 0;
      new ResizeObserver(() => {
        const h = chatEl.clientHeight;
        if (h && (!chatH || h !== chatH)) restoreChatScroll();
        chatH = h;
      }).observe(chatEl);

      input = el("input", { class: "np-input", type: "text", placeholder: "Message the party…", "aria-label": "Message the party", maxlength: "500", autocomplete: "off" });
      input.addEventListener("input", updateSend);
      input.addEventListener("input", () => {
        mention.update();
        if (input.value.trim() && !editing) typing.ping();
      });
      input.addEventListener("click", () => mention.update());
      input.addEventListener("blur", () => setTimeout(() => shadow.activeElement !== input && mention.close(), 150));
      for (const t of ["keyup", "mouseup", "select", "input", "blur"]) input.addEventListener(t, rememberSel);
      sendBtn = iconBtn(ICON.send, "Send (Enter)", sendChat, "np-send");
      sendBtn.type = "submit";
      sendBtn.disabled = true;
      emojiBtn = el("button", { type: "button", class: "np-tool", title: "Emoji", "aria-label": "Emoji", "aria-expanded": "false", onclick: () => emoji.toggle() }, svg(ICON.smile));
      gifBtn = el("button", { type: "button", class: "np-tool np-tool-gif", title: "Send a GIF", "aria-label": "GIFs", "aria-expanded": "false", onclick: () => gif.toggle() }, "GIF");
      reactBtn = el("button", { type: "button", class: "np-tool np-emo", title: "React on everyone's screen", "aria-label": "Reactions", "aria-expanded": "false", onclick: () => reactions.toggle() }, "🎉");
      reactBtn.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && reactions.hoverOpen());
      reactBtn.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && reactions.hoverLeave());
      fontBtn = el("button", { type: "button", class: "np-tool np-tool-font", onclick: cycleFont }, "Aa");
      spoilerBtn = el("button", {
        type: "button", class: "np-tool np-tool-sp", title: "Spoiler: hide this message until tapped (or put ||double bars|| around words)",
        "aria-label": "Spoiler", "aria-pressed": "false", onclick: () => (setSpoiler(!spoilerOn), input.focus()),
      }, svg(ICON.eyeOff));
      setBtn = el("button", { type: "button", class: "np-tool np-tool-set", title: "Settings", "aria-label": "Settings", "aria-expanded": "false", onclick: () => settings.toggle() }, svg(ICON.gear));
      for (const b of [emojiBtn, gifBtn, reactBtn, spoilerBtn, setBtn, fontBtn]) keepFocus(b);
      typingEl = el("div", { class: "np-typing", "aria-live": "polite" });
      typingEl.hidden = true;
      composer = el(
        "form",
        { class: "np-composer", onsubmit: (e) => (e.preventDefault(), sendChat()) },
        typingEl,
        mention.build(),
        el("div", { class: "np-tools" }, emojiBtn, gifBtn, reactBtn, spoilerBtn, el("span", { class: "np-grow" }), setBtn, fontBtn),
        reply.build(),
        edit.build(),
        el("div", { class: "np-row" }, input, sendBtn),
      );

      const leaveBtn = el(
        "button",
        {
          type: "button",
          class: "np-link-btn",
          onclick: leaveClick,
        },
        "Leave party",
      );

      // any-video mode: Theater (the video fills the window, the chat stays beside it) and notes about the video
      const THEATER_TIP = "Theater mode: the video fills the window and the chat stays beside it. The player's own fullscreen button hides the chat.";
      theaterBtn = el("button", { type: "button", class: "np-pill np-pill-soft np-theater", title: THEATER_TIP, "aria-pressed": "false", onclick: () => anyV.toggleTheater() }, svg(ICON.theater), el("span", {}, "Theater"));
      fsBtn = el(
        "button",
        {
          type: "button", class: "np-pill np-pill-soft np-fs", title: "Full screen with the chat still showing (Esc to leave)",
          onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}),
        },
        svg(ICON.expand),
        el("span", {}, "Full screen"),
      );
      theaterIcon = el("button", { type: "button", class: "np-icon np-head-act np-theater-icon", title: THEATER_TIP, "aria-label": "Theater mode", "aria-pressed": "false", onclick: () => anyV.toggleTheater() }, svg(ICON.theater));
      anyRow = el("div", { class: "np-any-row" }, theaterBtn, fsBtn);
      anyNote = el("div", { class: "np-any-note", role: "status" });
      if (!IS_ANY) anyRow.hidden = anyNote.hidden = theaterIcon.hidden = true;
      headEl.querySelector(".np-head-acts").prepend(theaterIcon);

      panel = el(
        "aside",
        { class: "np-panel", "aria-label": "NetParty chat" },
        head,
        el("div", { class: "np-actions" }, el("div", { class: "np-actions-l" }, copyBtn, recapBtn), leaveBtn),
        anyRow,
        anyNote,
        (holdBar = el(
          "div",
          { class: "np-hold", role: "status" },
          (holdTxt = el("span", { class: "np-hold-txt" })),
          (holdBtn = el("button", { type: "button", class: "np-pill np-hold-btn", onclick: () => hold.resume() }, "Resume")),
        )),
        el("div", { class: "np-section-label" }, "Watching"),
        peopleEl,
        voiceBox,
        pin.build(),
        chatEl,
        composer,
      );
      holdBar.hidden = true;
      // keep clicks and scrolls inside the panel from reaching the player
      for (const evt of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel", "contextmenu"])
        panel.addEventListener(evt, (e) => e.stopPropagation());
      camUi.init(); // the (hidden) camera view
      root = el("div", { class: "np-root" }, floatLayer, camLayer, toggleBtn, toastEl, panel);
      shadow.append(root);
      camUi.render();
      setFont(font);
      setTheme(theme);
      reactions.set(reactionPref);
      shadow.addEventListener("pointerdown", (e) => pops.outside(e.composedPath()), true);
      document.addEventListener("pointerdown", (e) => !e.composedPath().includes(host) && pops.close(), true);
      document.addEventListener("fullscreenchange", () => {
        mount();
        dockCheck(true);
        if (IS_ANY) render();
      });
    }

    // ---- split-screen dock: the site's player shrinks to make room for the chat column
    let pageStyle = null;
    let lastDockSig = "";
    const dockWidth = () => Math.round(Math.min(380, Math.max(300, innerWidth * 0.22)));
    function ensurePageStyle() {
      if (pageStyle?.isConnected) return;
      pageStyle = el("style", { id: "netparty-dock-style" });
      pageStyle.textContent = `
html.np-docked [data-np-shrink] {
  left: 0 !important; right: auto !important;
  width: calc(100% - var(--np-w)) !important; max-width: calc(100% - var(--np-w)) !important; min-width: 0 !important;
}`;
      (document.head || document.documentElement).append(pageStyle);
    }
    // Narrow exactly the site's player box (on YouTube: the watch page and its top bar).
    // The site then lays out the video and its controls inside the smaller box itself,
    // so nothing is cropped. (Forcing widths on the <video> or its inner wrappers fights
    // the player's own sizing and crops the picture.)
    // JioHotstar and Prime Video: the generic search below (from the player's <video> up to the
    // outermost full-width box, stopping at a position:fixed one such as Prime's overlay player).
    const PLAYER_BOX = {
      netflix: [".sizing-wrapper", ".watch-video--player-view", ".watch-video", "[data-uia=player]"],
      hotstar: [],
      prime: [],
    };
    function playerBox() {
      for (const sel of (IS_HOTSTAR || IS_PRIME || IS_HBO || IS_CR || IS_SL ? [] : PLAYER_BOX.netflix)) {
        const n = document.querySelector(sel);
        if (n && n.getBoundingClientRect().width > 0) return n;
      }
      // generic: the outermost full-width ancestor of the video, below the page root
      const top = document.fullscreenElement || document.body;
      // Crunchyroll: the player is an iframe (its <video> is in another document)
      const v = mainVideo() || (IS_CR ? crFrameEl() : null);
      let box = null;
      for (let n = v?.parentElement; n && n !== top && n !== document.documentElement; n = n.parentElement) {
        if (n === host) break;
        const r = n.getBoundingClientRect();
        const wide = n.hasAttribute("data-np-shrink") || (r.width >= innerWidth - 2 && r.left <= 1);
        if (wide) box = n;
        // a fixed-position box ignores its ancestors' width, so narrowing above it does nothing
        if (wide && getComputedStyle(n).position === "fixed") break;
      }
      return box;
    }
    function shrinkTargets() {
      if (IS_YT) {
        // ytd-watch-flexy holds the player in every mode (default, theater, and fullscreen,
        // where YouTube fullscreens <ytd-app>); the fixed top bar is narrowed separately
        const flexy = document.querySelector("ytd-watch-flexy");
        const fs = document.fullscreenElement;
        if (flexy && flexy.getBoundingClientRect().width > 0 && (!fs || fs.contains(flexy)))
          return [flexy, document.querySelector("#masthead-container")].filter(Boolean);
      }
      const box = playerBox();
      return box ? [box] : [];
    }
    function markShrinkTargets() {
      const want = shrinkTargets();
      if (!want.length) return;
      const cur = [...document.querySelectorAll("[data-np-shrink]")];
      if (want.length === cur.length && want.every((n) => cur.includes(n))) return;
      for (const old of cur) if (!want.includes(old)) old.removeAttribute("data-np-shrink");
      for (const n of want) n.setAttribute("data-np-shrink", "");
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }
    function dockCheck(force) {
      const docked = open && !!party.roomId && !!videoIdFromUrl();
      const w = dockWidth();
      const sig = [docked, w, !!document.fullscreenElement].join();
      const html = document.documentElement;
      if (docked) {
        ensurePageStyle();
        html.style.setProperty("--np-w", w + "px");
        host.style.setProperty("--np-w", w + "px");
        // any page: nothing on the site is narrowed; Theater mode leaves room for the panel instead
        if (!IS_ANY) markShrinkTargets();
      }
      if (IS_ANY) anyV.setReserved(docked ? w : 0);
      if (sig === lastDockSig && !force) return;
      lastDockSig = sig;
      html.classList.toggle("np-docked", docked);
      // let the player recompute its layout for the new size
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }
    addEventListener("resize", (e) => {
      if (e.isTrusted) dockCheck();
    });

    function mount() {
      if (!host) build();
      // sites fullscreen a container element; the overlay must live inside it to stay visible
      // (a <video> or <iframe> in fullscreen can't hold it: the chat can't show over native video fullscreen)
      const fs = document.fullscreenElement;
      const parent = (fs && fs.localName !== "video" && fs.localName !== "iframe" ? fs : null) || document.body;
      if (parent && host.parentElement !== parent) parent.append(host);
      // only on a watch page; on Netflix's browse pages the party waits in the background
      host.style.display = party.roomId && videoIdFromUrl() ? "" : "none";
      if (!party.roomId && open) {
        open = false;
        root.classList.remove("np-open");
        pops.close();
        dockCheck();
      }
    }

    let gifProbed = false;
    function show() {
      open = true;
      sessionStorage.setItem("netpartyPanel", "open");
      unread = 0;
      unreadAt = false;
      mount();
      root.classList.add("np-open");
      toastEl.classList.remove("np-show");
      peopleSig = voiceBox.dataset.sig = "";
      render();
      camUi.render(); // docked cameras move back into the panel
      dockCheck();
      restoreChatScroll();
      requestAnimationFrame(restoreChatScroll);
      if (!gifProbed && party.roomId) {
        gifProbed = true;
        gif.probe();
      }
      setTimeout(() => input.focus(), 50);
    }
    function hide() {
      open = false;
      if (party.roomId) sessionStorage.setItem("netpartyPanel", "closed");
      pops.close();
      root?.classList.remove("np-open");
      render();
      if (host) {
        camUi.render(); // docked cameras float while the chat is closed
        dockCheck();
      }
    }

    function toast(name, text, atMe = false) {
      if (open) return;
      toastEl.replaceChildren(el("b", {}, name), atMe ? " mentioned you: " : " ", text.length > 80 ? text.slice(0, 80) + "…" : text);
      toastEl.classList.toggle("np-toast-at", atMe);
      toastEl.classList.add("np-show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove("np-show"), 4000);
    }

    const metaText = () => {
      const st = party.state;
      if (!st) return "";
      if (adPlaying()) return "Waiting for ad to finish…";
      return `${st.playing ? "▶ Playing" : "❚❚ Paused"} at ${fmt(expectedPosition(st))}${party.hostOnly ? " · host controls playback" : ""}${party.locked ? " · locked" : ""}`;
    };

    // 2.2: "Waiting for Rahul to load…" / "Rahul disconnected, paused" (+ Resume once they've left)
    function drawHold() {
      if (!holdBar) return;
      const t = party.roomId ? hold.text() : "";
      if (holdTxt.textContent !== t) holdTxt.textContent = t;
      holdBar.hidden = !t;
      holdBtn.hidden = !t || !hold.canResume;
    }
    // 2.2: "Rahul is typing…" / "2 people are typing…" just above the chat box
    function drawTyping(ids) {
      if (!typingEl) return;
      const t = !ids.length ? "" : ids.length === 1 ? `${nameOf(ids[0])} is typing…` : `${ids.length} people are typing…`;
      if (typingEl.textContent !== t) typingEl.textContent = t;
      typingEl.hidden = !t;
    }
    // 2.2: Settings in the panel (the same switches as the popup's Settings)
    const settings = (() => {
      let node;
      const ITEMS = [
        ["syncWait", "Wait when someone's video is loading", "Pauses everyone and plays on together once it has loaded (or after 20 seconds)."],
        ["dropPause", "Pause when someone drops out", "Plays on when they're back, or offers Resume if they don't come back."],
        ["autoDuck", "Lower the video while friends talk", "In voice chat, the video plays quieter while someone speaks."],
      ];
      // 2.3: the host's party switches (shown to the host only; the server checks too)
      const HOST_ITEMS = [
        ["hostOnly", "Only you can play, pause and skip", "Everyone else follows you.", (on) => hostCtl.setHostOnly(on)],
        ["locked", "Lock the party", "No one new can join. People already here can come back.", (on) => hostCtl.lock(on)],
      ];
      let hostBox;
      function draw() {
        if (!node) return;
        for (const b of node.querySelectorAll("[data-pref]")) b.setAttribute("aria-checked", String(prefs[b.dataset.pref]));
        hostBox.hidden = !party.roomId || party.me !== party.hostId;
        for (const b of hostBox.querySelectorAll("[data-host-set]")) b.setAttribute("aria-checked", String(!!party[b.dataset.hostSet]));
      }
      return {
        draw,
        toggle() {
          if (!node) {
            hostBox = el(
              "div",
              { class: "np-set-host" },
              el("div", { class: "np-pop-title" }, "Party"),
              ...HOST_ITEMS.map(([k, label, sub, set]) =>
                el("button", {
                  type: "button", class: "np-switch", role: "switch", "data-host-set": k, "aria-checked": "false",
                  onclick: async (e) => {
                    // busy while the server answers (not disabled: that would take the keyboard focus away)
                    const b = e.currentTarget;
                    if (b.getAttribute("aria-busy") === "true") return;
                    b.setAttribute("aria-busy", "true");
                    try {
                      await set(!party[k]);
                    } catch (err) {
                      system(hostErr(err));
                    } finally {
                      b.removeAttribute("aria-busy");
                      draw();
                    }
                  },
                }, el("span", { class: "np-switch-txt" }, el("span", { class: "np-switch-label" }, label), el("small", {}, sub)), el("span", { class: "np-switch-track", "aria-hidden": "true" })),
              ),
            );
            node = popEl(
              "np-set-pop",
              "Settings",
              hostBox,
              el("div", { class: "np-pop-title" }, "Settings"),
              ...ITEMS.map(([k, label, sub]) =>
                el("button", {
                  type: "button", class: "np-switch", role: "switch", "data-pref": k, "aria-checked": "true",
                  onclick: () => {
                    const on = !prefs[k];
                    prefs[k] = on;
                    draw();
                    (on ? chrome.storage.sync.remove(k) : chrome.storage.sync.set({ [k]: false })).catch(() => {});
                  },
                }, el("span", { class: "np-switch-txt" }, el("span", { class: "np-switch-label" }, label), el("small", {}, sub)), el("span", { class: "np-switch-track", "aria-hidden": "true" })),
              ),
            );
            node.addEventListener("np-close", () => setBtn.classList.remove("np-on"));
            panel.append(node);
          }
          draw();
          if (pops.current === node) return pops.close();
          pops.open(node, setBtn);
          setBtn.classList.add("np-on");
        },
      };
    })();

    // a popover just below what opened it (kept inside the panel)
    function placeUnder(node, anchor) {
      const pr = panel.getBoundingClientRect(), ar = anchor?.getBoundingClientRect();
      let top = ar && panel.contains(anchor) ? ar.bottom - pr.top + 6 : headEl.offsetHeight + 4;
      top = Math.max(8, Math.min(top, panel.clientHeight - node.offsetHeight - 8));
      node.style.top = Math.round(top) + "px";
    }

    // ---- 2.3: Invite friends. Copy the link, or copy it and open WhatsApp, Discord or Instagram to paste it
    // there, or show it as a QR code to send it from your phone. The link carries the party's key after the #,
    // so nothing here puts it into another site's address (a "share" URL would hand the key to that site's
    // servers): the apps open on their own start page and you paste the link into a chat.
    const SHARE_APPS = [
      { id: "whatsapp", label: "WhatsApp", icon: ICON.whatsapp },
      { id: "discord", label: "Discord", icon: ICON.discord },
      { id: "instagram", label: "Instagram", icon: ICON.instagram },
    ];
    const share = (() => {
      let node, linkEl, msgEl, qrBtn, copyBtn2, msgT = 0;
      const shortLink = (l) => l.replace(/^https?:\/\//, "").replace(/#k=.*$/, "#k=••••");
      const say = (t) => {
        msgEl.textContent = t;
        clearTimeout(msgT);
        msgT = setTimeout(() => (msgEl.textContent = ""), 6000);
      };
      async function copy() {
        const link = inviteLink();
        if (!link) return false;
        try {
          await navigator.clipboard.writeText(link);
          return true;
        } catch {
          return false;
        }
      }
      async function app(a) {
        if (!(await copy())) return say("Couldn't copy the link. Click in the page and try again.");
        // the background opens the app's own start page (a fixed address; the link never goes into it)
        await chrome.runtime.sendMessage({ cmd: "shareOpen", app: a.id }).catch(() => {});
        say(`Invite link copied. Paste it into a chat on ${a.label}.`);
      }
      // The QR code isn't drawn here: this panel is part of the site's page, and the site could read a canvas in it
      // (and so the key in the link). The background shows it in NetParty's own window instead.
      async function showQr() {
        const link = inviteLink();
        if (!link) return;
        if (!globalThis.NP_QR?.encode(link)) return say("This link is too long for a QR code. Copy it instead.");
        const r = await chrome.runtime.sendMessage({ cmd: "shareQr", op: "show", link }).catch(() => null);
        say(r?.ok ? "The QR code is open in a small NetParty window. Scan it with your phone's camera." : "Couldn't show the QR code. Use the NetParty icon in the toolbar instead.");
      }
      function refresh() {
        if (!node) return;
        const link = inviteLink();
        linkEl.textContent = link ? shortLink(link) : "";
        linkEl.title = link ? "Your invite link (the key after # is hidden here)" : "";
      }
      return {
        refresh,
        toggle(anchor) {
          if (!node) {
            linkEl = el("span", { class: "np-share-link" });
            copyBtn2 = el(
              "button",
              {
                type: "button", class: "np-pill np-share-copy",
                onclick: async () => {
                  if (!(await copy())) return say("Couldn't copy the link. Click in the page and try again.");
                  copyBtn2.lastChild.textContent = "Copied!";
                  setTimeout(() => (copyBtn2.lastChild.textContent = "Copy link"), 1500);
                  say("Invite link copied.");
                },
              },
              svg(ICON.link),
              el("span", {}, "Copy link"),
            );
            qrBtn = el("button", { type: "button", class: "np-share-app", "data-app": "qr", title: "Show the link as a QR code to scan with your phone", onclick: showQr }, el("span", { class: "np-share-ic" }, svg(ICON.qr)), el("span", {}, "QR code"));
            msgEl = el("div", { class: "np-share-msg", role: "status" });
            node = popEl(
              "np-share-pop",
              "Invite friends",
              el("div", { class: "np-pop-title" }, "Invite friends"),
              el("div", { class: "np-share-row" }, linkEl, copyBtn2),
              el(
                "div",
                { class: "np-share-apps" },
                ...SHARE_APPS.map((a) => el("button", { type: "button", class: "np-share-app", "data-app": a.id, title: `Copy the link and open ${a.label}`, onclick: () => app(a) }, el("span", { class: "np-share-ic" }, svg(a.icon)), el("span", {}, a.label))),
                qrBtn,
              ),
              msgEl,
              el("small", { class: "np-share-note" }, "🔒 The link unlocks your encrypted chat. Send it only to friends."),
            );
            panel.append(node);
          }
          refresh();
          pops.open(node, anchor, 0);
          if (pops.current !== node) return;
          placeUnder(node, anchor);
        },
      };
    })();

    // ---- 2.3: a friend's menu (click them in the people row): their voice volume, and for the host,
    // Make host / Remove from party
    const memberMenu = (() => {
      let node, pid = null, removeArm = 0;
      function close() {
        if (pops.current === node) pops.close();
      }
      function build() {
        const m = party.members.find((x) => x.id === pid);
        if (!m) return close();
        const amHost = party.me === party.hostId;
        const inVoice = voice.active && !!m.inVoice;
        const kids = [
          el("div", { class: "np-mm-head" },
            paintPic(el("span", { class: "np-mm-av np-emo", style: `--h:${hue(pid)}` }), pid),
            el("span", { class: "np-mm-name" }, nameOf(pid)),
            ...(m.host ? [el("span", { class: "np-mm-tag" }, "Host")] : []),
          ),
        ];
        if (inVoice) {
          const pct = el("span", { class: "np-mm-pct" });
          const range = el("input", { type: "range", min: "0", max: "100", step: "5", class: "np-mm-vol", "aria-label": `${nameOf(pid)}'s voice volume` });
          const show = () => (pct.textContent = range.value + "%");
          range.value = String(Math.round(voice.peerVolume(pid) * 100));
          show();
          range.addEventListener("input", () => {
            voice.setPeerVolume(pid, Number(range.value) / 100);
            show();
          });
          kids.push(el("label", { class: "np-mm-row" }, svg(ICON.volume), el("span", { class: "np-mm-lab" }, "Volume"), range, pct));
        }
        if (amHost && pid !== party.me) {
          const busy = (b, fn) => async () => {
            if (b.getAttribute("aria-busy") === "true") return;
            b.setAttribute("aria-busy", "true");
            try {
              await fn();
              close();
            } catch (e) {
              system(hostErr(e));
            } finally {
              b.removeAttribute("aria-busy");
            }
          };
          const mk = el("button", { type: "button", class: "np-menu-btn", ...(m.away ? { disabled: "", title: "They aren't connected right now" } : {}) }, svg(ICON.crown), el("span", {}, "Make host"));
          mk.onclick = busy(mk, () => hostCtl.promote(pid));
          const rm = el("button", { type: "button", class: "np-menu-btn np-danger" }, svg(ICON.userX), el("span", {}, "Remove from party"));
          rm.onclick = async () => {
            // press twice (like Delete on a message)
            if (Date.now() - removeArm > 4000) {
              removeArm = Date.now();
              rm.classList.add("np-armed");
              rm.lastChild.textContent = "Press again to remove " + nameOf(pid);
              setTimeout(() => rm.isConnected && Date.now() - removeArm >= 4000 && (rm.classList.remove("np-armed"), (rm.lastChild.textContent = "Remove from party")), 4100);
              return;
            }
            removeArm = 0;
            await busy(rm, () => hostCtl.remove(pid))();
          };
          kids.push(el("div", { class: "np-mm-acts" }, mk, rm));
        }
        node.replaceChildren(...kids);
      }
      return {
        // does this member have anything in their menu for us right now?
        has: (m) => m.id !== party.me && ((voice.active && !!m.inVoice) || party.me === party.hostId),
        toggle(anchor, id) {
          if (!node) {
            node = popEl("np-member-pop", "Member");
            node.addEventListener("np-close", () => (pid = null));
            panel.append(node);
          }
          if (pops.current === node && pid === id) return close();
          pid = id;
          removeArm = 0;
          node.setAttribute("aria-label", nameOf(id));
          build();
          pops.open(node, anchor, 0);
          if (pops.current !== node) return;
          placeUnder(node, anchor);
        },
        // the party changed while it's open (they left, someone became host, voice)
        sync() {
          if (!node || pops.current !== node || !pid) return;
          if (!party.members.some((m) => m.id === pid) || !memberMenu.has(party.members.find((m) => m.id === pid))) return close();
          if (shadow.activeElement?.classList?.contains("np-mm-vol")) return; // don't rebuild under a drag
          build();
        },
      };
    })();

    // ---- 2.3: leaving as the host: hand the party to someone so it carries on, or end it for everyone
    const leaveMenu = (() => {
      let node;
      return {
        toggle(anchor) {
          if (!node) {
            node = popEl("np-leave-pop", "Leave the party");
            panel.append(node);
          }
          if (pops.current === node) return pops.close();
          const others = party.members.filter((m) => m.id !== party.me && !m.away);
          const end = el("button", { type: "button", class: "np-menu-btn np-danger" }, svg(ICON.leave), el("span", {}, "End the party for everyone"));
          end.onclick = () => {
            pops.close();
            leaveParty({ end: true });
          };
          node.replaceChildren(
            el("div", { class: "np-pop-title" }, "Leave the party"),
            el("p", { class: "np-leave-txt" }, "Hand it to someone so it keeps going without you, or end it for everyone."),
            el(
              "div",
              { class: "np-mm-acts np-leave-list" },
              ...others.map((m) => {
                const b = el(
                  "button",
                  { type: "button", class: "np-menu-btn", "data-pid": m.id },
                  paintPic(el("span", { class: "np-mm-av np-emo", style: `--h:${hue(m.id)}` }), m.id),
                  el("span", {}, `Make ${nameOf(m.id)} host and leave`),
                );
                b.onclick = async () => {
                  if (b.disabled) return;
                  b.disabled = true;
                  try {
                    pops.close();
                    await hostCtl.handOver(m.id);
                  } catch (e) {
                    b.disabled = false;
                    system(hostErr(e));
                  }
                };
                return b;
              }),
              end,
            ),
          );
          pops.open(node, anchor, 0);
          if (pops.current !== node) return;
          placeUnder(node, anchor);
        },
      };
    })();

    function render() {
      if (!host) return;
      mount();
      badge.textContent = (unreadAt ? "@" : "") + (unread > 9 ? "9+" : unread ? String(unread) : "");
      badge.style.display = unread ? "" : "none";
      badge.classList.toggle("np-badge-at", unreadAt);
      pin.draw();
      drawHold();
      codeEl.textContent = party.roomId ? "· " + party.roomId : "";
      const leaveLabel = party.me && party.me === party.hostId ? "End the party for everyone" : "Leave party";
      if (leaveIcon.title !== leaveLabel) {
        leaveIcon.title = leaveLabel;
        leaveIcon.setAttribute("aria-label", leaveLabel);
      }
      metaEl.textContent = metaText();
      metaEl.classList.toggle("np-ad", adPlaying());
      if (IS_ANY) renderAny();

      // 2.3: the host's switches, the invite link and an open member menu follow the party
      settings.draw();
      share.refresh();
      memberMenu.sync();
      const amHost = party.me === party.hostId;
      const pSig = party.members
        .map((m) => {
          const isMe = m.id === party.me;
          const info = isMe ? { muted: voice.muted, speaking: voice.speaking } : voice.peerInfo(m.id);
          return [m.id, nameOf(m.id), picKey(picSpec(m.id)), m.host, isMe ? voice.active : m.inVoice, info.muted, info.speaking, info.connected, !!m.away].join(":");
        })
        .join("|") + "#" + amHost + voice.active;
      if (pSig !== peopleSig) {
        peopleSig = pSig;
        peopleEl.replaceChildren(
          ...party.members.map((m) => {
            const isMe = m.id === party.me;
            const info = isMe ? { muted: voice.muted, speaking: voice.speaking } : voice.peerInfo(m.id);
            const inVoice = isMe ? voice.active : !!m.inVoice;
            const avatar = el("div", { class: "np-avatar np-emo", style: `--h:${hue(m.id)}` }, paintPic(el("span", { class: "np-avatar-pic" }), m.id));
            if (m.host) avatar.append(el("span", { class: "np-crown", title: "Host" }, svg(ICON.crown)));
            if (inVoice) avatar.append(el("span", { class: "np-mic" + (info.muted ? " np-off" : ""), title: info.muted ? "Muted" : "In voice" }, svg(info.muted ? ICON.micOff : ICON.mic)));
            const label = nameOf(m.id) + (m.host ? " (host)" : "");
            // 2.3: someone else is a button when their menu has something in it (volume in voice; host controls)
            const tile = isMe
              ? el("button", { type: "button", class: "np-person np-me", title: "Change your name and picture", "aria-label": "Change your name and picture", "aria-haspopup": "dialog", onclick: (e) => avatarPicker.toggle(e.currentTarget, e.detail === 0) })
              : memberMenu.has(m)
                ? el("button", { type: "button", class: "np-person", "data-pid": m.id, title: label + (amHost ? ": volume and host controls" : ": volume"), "aria-label": label + ": options", "aria-haspopup": "dialog", onclick: (e) => memberMenu.toggle(e.currentTarget, m.id) })
                : el("div", { class: "np-person", "data-pid": m.id, title: label });
            if (m.away) tile.classList.add("np-away");
            tile.classList.toggle("np-speaking", inVoice && info.speaking && !info.muted);
            if (!isMe && inVoice && voice.active) tile.dataset.link = info.connected ? "connected" : "connecting";
            tile.append(avatar, el("div", { class: "np-pname" }, isMe ? "You" : nameOf(m.id)));
            return tile;
          }),
        );
        // names and pictures on chat lines and camera tiles follow profile changes
        refreshNames();
        camUi.render();
      }

      const inVoiceCount = party.members.filter((m) => (m.id === party.me ? voice.active : m.inVoice)).length;
      // only rebuild the voice bar when it changes (so the volume slider isn't replaced mid-drag)
      const sig = [voice.active, voice.muted, voice.speaking, inVoiceCount, voice.camOn, voice.camBusy].join();
      if (sig === voiceBox.dataset.sig) return;
      voiceBox.dataset.sig = sig;
      if (!voice.active) {
        voiceBox.replaceChildren(
          el(
            "button",
            { type: "button", class: "np-join-voice", onclick: () => voice.join() },
            svg(ICON.mic),
            el("span", {}, inVoiceCount ? `Join voice · ${inVoiceCount} talking` : "Join voice chat"),
          ),
        );
      } else {
        const vol = el("input", { type: "range", min: "0", max: "1", step: "0.05", class: "np-vol", title: "Friends' voice volume", "aria-label": "Friends' voice volume" });
        vol.value = String(voice.volume ?? 1);
        vol.addEventListener("input", () => voice.setVolume(Number(vol.value)));
        voiceBox.replaceChildren(
          el(
            "div",
            { class: "np-voice-bar" },
            el("button", { type: "button", class: "np-round" + (voice.muted ? " np-muted" : ""), title: voice.muted ? "Unmute" : "Mute", "aria-label": voice.muted ? "Unmute" : "Mute", onclick: () => voice.toggleMute() }, svg(voice.muted ? ICON.micOff : ICON.mic)),
            el("div", { class: "np-voice-label" }, voice.muted ? "You're muted" : voice.speaking ? "Speaking…" : "Voice on", el("small", {}, `${inVoiceCount} in voice`)),
            vol,
            el(
              "button",
              {
                type: "button", class: "np-round np-cam-btn" + (voice.camOn ? " np-on" : ""),
                title: voice.camOn ? "Turn camera off" : "Turn camera on", "aria-label": voice.camOn ? "Turn camera off" : "Turn camera on",
                "aria-pressed": String(voice.camOn), ...(voice.camBusy ? { disabled: "" } : {}), onclick: () => voice.toggleCamera(),
              },
              svg(voice.camOn ? ICON.cam : ICON.camOff),
            ),
            el("button", { type: "button", class: "np-round np-hang", title: "Leave voice", "aria-label": "Leave voice", onclick: () => voice.leave() }, svg(ICON.phoneOff)),
          ),
        );
      }
    }

    // any-video mode: Theater state, and a note when the video isn't the host's, can't be found, or is live
    function renderAny() {
      const t = anyV.theater;
      theaterBtn.setAttribute("aria-pressed", String(t));
      theaterIcon.setAttribute("aria-pressed", String(t));
      theaterBtn.lastChild.textContent = t ? "Exit theater" : "Theater";
      theaterBtn.disabled = theaterIcon.disabled = !anyV.ready;
      fsBtn.hidden = !t;
      fsBtn.lastChild.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
      let note = null;
      if (anyMismatch) {
        const u = party.page?.u;
        note = [
          el("b", {}, "You're on a different video."),
          " Your video's length doesn't match the host's, so sync is paused for you.",
          ...(u ? [el("button", { type: "button", class: "np-pill np-any-open", onclick: () => openHostPage() }, "Open host's page")] : []),
        ];
      } else if (!anyV.ready && anyV.frameHint) {
        let site = anyV.frameHint;
        try {
          site = new URL(anyV.frameHint).host;
        } catch {}
        note = [el("b", {}, "The video is in a player from " + site + "."), " Click the NetParty icon in the toolbar and press Allow to sync it."];
      } else if (!anyV.ready) note = [el("b", {}, "No video found on this page."), " Play the video, or open the page it's on."];
      else if (anyLive()) note = ["Live stream: only play and pause are synced."];
      const sig = anyMismatch + "|" + anyV.ready + "|" + anyV.frameHint + "|" + anyLive() + "|" + (party.page?.u || "");
      if (anyNote.dataset.sig === sig) return;
      anyNote.dataset.sig = sig;
      anyNote.replaceChildren(...(note || []));
      anyNote.hidden = !note;
      anyNote.classList.toggle("np-warn", !!note && !anyLive());
    }

    function chatToBottom() {
      chatStick = true;
      chatEl.scrollTop = chatEl.scrollHeight;
      chatSaved = chatEl.scrollTop;
    }
    function restoreChatScroll() {
      if (!chatEl || !chatEl.clientHeight) return;
      if (chatStick) chatEl.scrollTop = chatEl.scrollHeight;
      else chatEl.scrollTop = chatSaved;
    }
    function addLine(node) {
      if (!host) build();
      const visible = chatEl.clientHeight > 0;
      const nearBottom = visible ? chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60 : chatStick;
      chatEl.append(node);
      while (chatEl.childElementCount > 200) {
        const gone = chatEl.firstElementChild;
        media.release(gone);
        if (gone.dataset.mid) msgReactions.forget(gone.dataset.mid);
        gone.remove();
      }
      if (nearBottom || !open) chatToBottom();
    }

    // 2.2: a line's text with its mentions (current names) and spoilers (blurred until tapped, for each viewer)
    function richText(text, marks = {}) {
      const ranges = [...(marks.sp || []).map((x) => ({ ...x, k: "sp" })), ...(marks.mn || []).map((x) => ({ ...x, k: "mn" }))].sort((a, b) => a.i - b.i);
      const out = [];
      let at = 0;
      for (const r of ranges) {
        if (r.i < at) continue;
        if (r.i > at) out.push(...linkify(text.slice(at, r.i)));
        if (r.k === "sp") out.push(spoilerEl(r.s));
        else {
          const known = r.p === party.me || party.profiles.has(r.p) || party.members.some((m) => m.id === r.p);
          out.push(el("span", { class: "np-mention" + (r.p === party.me ? " np-mention-me" : ""), "data-mpid": r.p, ...(known ? {} : { "data-orig": text.substr(r.i, r.n) }) }, known ? "@" + nameOf(r.p) : text.substr(r.i, r.n)));
        }
        at = r.i + r.n;
      }
      if (at < text.length) out.push(...linkify(text.slice(at)));
      return out;
    }
    function spoilerEl(hidden) {
      const b = el("button", { type: "button", class: "np-spoiler", title: "Spoiler: tap to show", "aria-label": "Spoiler, hidden. Press to show", "aria-expanded": "false" }, el("span", { class: "np-spoiler-t", "aria-hidden": "true" }, hidden));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const shown = b.classList.toggle("np-shown");
        b.setAttribute("aria-expanded", String(shown));
        b.title = shown ? "Spoiler: tap to hide again" : "Spoiler: tap to show";
        b.setAttribute("aria-label", shown ? "Spoiler: " + hidden : "Spoiler, hidden. Press to show");
        b.firstChild.setAttribute("aria-hidden", String(!shown));
      });
      return b;
    }
    const mentionsMe = (d) => d.id !== party.me && !!d.mn?.some((x) => x.p === party.me);
    // what a line can be quoted, pinned or edited as
    const infoOf = (d, mid) => ({ mid, uid: d.id, s: d.gif ? "" : d.sp ? "Spoiler" : cleanSnippet(d.text || ""), g: !!d.gif, sp: !!d.sp, raw: d.gif ? "" : rawText(d.text || "", d.sp) });

    // d: { id (sender pid), ts, text, mn?, sp? } or { id, ts, gif: { url, w, h } } (decrypted and checked)
    function chat(d, replay = false) {
      const mine = d.id === party.me;
      const time = new Date(d.ts || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const text = String(d.text || "");
      const who = nameOf(d.id);
      let body;
      if (d.gif && isKlipyMediaUrl(d.gif.url)) {
        // fit inside 200×200, keep the aspect ratio (space is reserved before it loads)
        const w = d.gif.w || 200, h = d.gif.h || 150, k = Math.min(1, 200 / w, 200 / h);
        const img = el("img", { class: "np-gif", alt: "GIF from " + who, width: String(Math.round(w * k)), height: String(Math.round(h * k)) });
        img.addEventListener("load", () => nearBottomScroll());
        media.load(img, d.gif.url);
        body = el("div", { class: "np-bubble np-bubble-gif" }, img, el("span", { class: "np-time" }, time));
      } else if (text) body = el("div", { class: "np-bubble" }, ...richText(text, d), el("span", { class: "np-time" }, time));
      else return;
      // everyone's lines, ours included, carry the sender's picture and name (ours on the right);
      // more lines from the same person within a minute stack under the first without repeating them
      const ts = Number(d.ts) || Date.now();
      if (!host) build();
      const prev = chatEl.lastElementChild;
      const cont = !!prev && prev.classList.contains("np-msg") && prev.dataset.uid === d.id && ts - Number(prev.dataset.ts) >= -5000 && ts - Number(prev.dataset.ts) < 60000;
      const mid = typeof d.mid === "string" && MID_RE.test(d.mid) && !msgNode(d.mid) ? d.mid : null;
      const line = el(
        "div",
        { class: "np-msg" + (mine ? " np-mine" : "") + (cont ? " np-cont" : ""), "data-uid": d.id, "data-ts": String(cont ? prev.dataset.ts : ts), ...(mid ? { "data-mid": mid } : {}) },
        paintPic(el("div", { class: "np-mav np-emo", "data-uid": d.id, style: `--h:${hue(d.id)}`, "aria-hidden": "true" }), d.id),
        el("div", { class: "np-mcol" }, el("div", { class: "np-author", "data-uid": d.id, style: `--h:${hue(d.id)}` }, who), ...(d.re ? [quoteEl(d.re)] : []), body),
      );
      if (mid) lineInfo.set(line, infoOf(d, mid));
      const atMe = mentionsMe(d);
      if (atMe) line.classList.add("np-at-me");
      addLine(line);
      if (!open && !mine && !replay) {
        unread++;
        if (atMe) unreadAt = true;
        toast(who, d.gif ? "sent a GIF" : text, atMe);
        render();
      }
      if (mid && pin.current?.id === mid) pin.draw();
    }
    // 2.2: an edit from the line's own sender (anyone else's is ignored)
    function msgEdit(d) {
      const node = msgNode(d.id);
      const info = node && lineInfo.get(node);
      if (!info || node.dataset.uid !== d.from || node.dataset.deleted || info.g) return;
      const bubble = node.querySelector(".np-bubble");
      const time = bubble.querySelector(".np-time");
      bubble.replaceChildren(...richText(d.text, d), el("span", { class: "np-edited" }, "(edited)"), time);
      lineInfo.set(node, infoOf({ ...d, id: d.from }, info.mid));
      node.classList.toggle("np-at-me", mentionsMe({ ...d, id: d.from }));
      if (pin.current?.id === info.mid) pin.draw();
      nearBottomScroll();
    }
    // 2.2: a delete from the line's own sender: "Message deleted" stays in its place
    function msgDelete(d) {
      const node = msgNode(d.id);
      if (!node || node.dataset.uid !== d.from || node.dataset.deleted) return;
      node.dataset.deleted = "1";
      acts.detach(node);
      const col = node.querySelector(".np-mcol");
      for (const n of col.querySelectorAll(".np-quote, .np-reacts")) n.remove();
      const bubble = col.querySelector(".np-bubble");
      const time = bubble.querySelector(".np-time");
      media.release(bubble);
      bubble.className = "np-bubble np-deleted";
      bubble.replaceChildren(el("span", {}, "Message deleted"), time);
      node.classList.remove("np-at-me");
      lineInfo.delete(node);
      msgReactions.forget(d.id);
      for (const q of chatEl.querySelectorAll(".np-quote[data-qid]"))
        if (q.dataset.qid === d.id) {
          const qs = q.querySelector(".np-quote-s");
          qs.textContent = "Message deleted";
          qs.className = "np-quote-s np-quote-del";
        }
      if (editing?.mid === d.id) edit.cancel();
      if (replyTo?.id === d.id) reply.cancel();
      if (pin.current?.id === d.id) pin.draw();
    }
    // the quoted line above a reply: name + one line (or "GIF"); click to jump to the original
    const quoteName = (re) => (re.uid && (re.uid === party.me || party.profiles.has(re.uid)) ? nameOf(re.uid) : re.name || (re.uid ? nameOf(re.uid) : "Someone"));
    function quoteEl(re) {
      const q = el(
        "button",
        { type: "button", class: "np-quote" + (re.id ? "" : " np-quote-noref"), title: re.id ? "Show the original message" : "", "aria-label": `Reply to ${quoteName(re)}: ${re.g ? "GIF" : re.s}` },
        el("span", { class: "np-quote-name", ...(re.uid ? { "data-quid": re.uid } : {}) }, quoteName(re)),
        el("span", { class: "np-quote-s" + (re.g ? " np-quote-gif" : re.sp ? " np-quote-sp" : "") }, re.g ? "GIF" : re.s),
      );
      if (re.name) q.dataset.qname = re.name;
      if (re.id) q.dataset.qid = re.id;
      q.addEventListener("click", (e) => (e.stopPropagation(), jumpTo(re.id, q)));
      return q;
    }
    // scroll the original into the middle of the chat and flash it (if it's still in the last 200 lines)
    function jumpTo(mid, from) {
      const node = msgNode(mid);
      if (!node) {
        from.classList.remove("np-gone");
        void from.offsetWidth;
        from.classList.add("np-gone");
        from.title = "That message is no longer in the chat";
        return;
      }
      const cr = chatEl.getBoundingClientRect(), nr = node.getBoundingClientRect();
      chatEl.scrollTop += nr.top - cr.top - Math.max(8, (chatEl.clientHeight - nr.height) / 2);
      chatStick = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
      chatSaved = chatEl.scrollTop;
      node.classList.remove("np-flash");
      void node.offsetWidth;
      node.classList.add("np-flash");
      clearTimeout(node._npFlash);
      node._npFlash = setTimeout(() => node.classList.remove("np-flash"), 1800);
    }
    // keep the newest message in view when a GIF above it finishes loading
    function nearBottomScroll() {
      if (!chatEl.clientHeight ? chatStick : chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 260) chatToBottom();
    }
    function system(text) {
      addLine(el("div", { class: "np-sys" }, text));
    }
    // "<name> joined / left", named from the member's decrypted profile (updates if it arrives later)
    function sysEvent(event, pid) {
      // 2.3: "removed" (by the host) and "host" (handed the party)
      const what = { join: " joined", leave: " left", removed: " was removed from the party", host: " is the host now" }[event] || " left";
      addLine(el("div", { class: "np-sys" }, el("span", { class: "np-who", "data-uid": pid }, nameOf(pid)), what));
    }
    function refreshNames() {
      if (!chatEl) return;
      for (const n of chatEl.querySelectorAll(".np-author[data-uid], .np-who[data-uid]")) {
        const v = nameOf(n.dataset.uid);
        if (n.textContent !== v) n.textContent = v;
      }
      for (const n of chatEl.querySelectorAll(".np-mav[data-uid]")) paintPic(n, n.dataset.uid);
      for (const n of chatEl.querySelectorAll(".np-quote-name[data-quid]")) {
        const v = quoteName({ uid: n.dataset.quid, name: n.parentNode.dataset.qname || null });
        if (n.textContent !== v) n.textContent = v;
      }
      // mentions show the member's current name
      for (const n of chatEl.querySelectorAll(".np-mention[data-mpid]")) {
        const pid = n.dataset.mpid;
        const known = pid === party.me || party.profiles.has(pid) || party.members.some((m) => m.id === pid);
        const v = known ? "@" + nameOf(pid) : n.dataset.orig || n.textContent;
        if (n.textContent !== v) n.textContent = v;
      }
      msgReactions.redraw();
      pin.draw();
    }
    // everything said in the party so far (the server keeps the last 150 lines, encrypted)
    function loadHistory(list) {
      if (!host) build();
      media.release(chatEl);
      chatEl.replaceChildren();
      msgReactions.clear();
      reply.cancel();
      acts.hide();
      system("🔒 Chat is end-to-end encrypted. Only people with the invite link can read it.");
      // reactions, edits and deletes are folded onto their lines (in order), then drawn once
      edit.cancel();
      for (const h of list) {
        if (h.kind === "chat") chat(h, true);
        else if (h.kind === "mr") msgReactions.apply(h, false);
        else if (h.kind === "me") msgEdit(h);
        else if (h.kind === "md") msgDelete(h);
        else sysEvent(h.event, h.id);
      }
      msgReactions.redraw();
      chatToBottom();
    }

    // the only thing that changes every second is the playback clock
    setInterval(() => {
      if (!party.roomId || !open || !metaEl) return;
      metaEl.textContent = metaText();
      metaEl.classList.toggle("np-ad", adPlaying());
    }, 1000);
    let reactionPref = null;
    return {
      mount,
      show,
      hide,
      render,
      chat,
      msgReact: (d) => host && msgReactions.apply(d),
      msgEdit: (d) => host && msgEdit(d),
      msgDelete: (d) => host && msgDelete(d),
      setPin(p) {
        if (!host) build();
        pin.set(p);
      },
      typing: (ids) => drawTyping(ids),
      hold: () => drawHold(),
      isOpen: () => open,
      prefsChanged: () => settings.draw(),
      system,
      sysEvent,
      refreshNames: () => {
        refreshNames();
        peopleSig = "";
        render();
      },
      loadHistory,
      float,
      setFont,
      setTheme,
      get theme() {
        return theme;
      },
      cams: () => host && camUi.render(),
      setReactions(v) {
        reactionPref = v;
        reactions.set(v);
      },
      dockCheck: () => host && dockCheck(),
    };
  })();

  // ---- any page: find the video for a new party or one we just joined.
  // -> { ok } | { picking } (the highlight overlay is up; the rest happens on the page) |
  //    { needFrame: origin } (the video is in a cross-origin iframe: the popup asks for that site) |
  //    { none } (no <video> anywhere we can see, e.g. a canvas-only player)
  async function anyFind(then) {
    if (anyV.ready) {
      await then();
      return { ok: true };
    }
    const f = anyV.find();
    if (f.pick) {
      anyV.attach(f.pick);
      await then();
      return { ok: true };
    }
    if (f.ambiguous) {
      (async () => {
        if (!(await anyV.pick(f.ambiguous))) return notice("No video picked. Click the NetParty icon to try again.");
        try {
          await then();
        } catch (e) {
          notice(e.message);
        }
      })();
      return { picking: true };
    }
    if (f.agent) {
      await then();
      return { ok: true };
    }
    if (f.frame) return { needFrame: f.frame.origin };
    return { none: true };
  }
  const NO_VIDEO = "No video found on this page.";

  // ------------------------------------------------ popup <-> content API
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // a video in a cross-origin iframe (anyvideo.js agent), relayed by the background: nothing to answer
    if (msg?.cmd === "npFrameEvt") {
      if (IS_ANY && Number.isInteger(msg.frameId)) anyV.onFrame(msg);
      else if (IS_CR && Number.isInteger(msg.frameId)) crFrame.onFrame(msg);
      return;
    }
    if (msg?.cmd === "npAgent") return; // for agents in subframes, not for us
    (async () => {
      try {
        switch (msg.cmd) {
          case "status":
            return {
              site: SITE_NAME,
              onWatchPage: !!videoIdFromUrl(),
              title: videoIdFromUrl() ? currentTitle() : "", // what's playing (the popup and tests; never sent anywhere)
              roomId: party.roomId,
              members: party.members.map((m) => nameOf(m.id)),
              invite: inviteLink(),
              hostOnly: party.hostOnly,
              locked: party.locked, // 2.3
              isHost: party.me === party.hostId,
              voice: voice.active,
              // 2.3: each friend's voice volume as it plays now, by name (never sent anywhere)
              levels: Object.fromEntries(Object.entries(voice.levels()).map(([id, v]) => [nameOf(id), v])),
              // 2.3: the recap's totals so far (popup and tests; never sent anywhere)
              recap: (() => {
                const r = recap.current();
                return r && { msgs: r.msgs, gifs: r.gifs, reacts: r.reacts, people: r.order.length, peak: r.peak, title: r.title, watchMs: r.watchMs };
              })(),
              chatOpen: false,
              any: IS_ANY,
              booted,
              video: IS_ANY ? anyV.ready : undefined,
              frameHint: IS_ANY ? anyV.frameHint : undefined,
              picking: IS_ANY ? anyV.picking : undefined,
            };
          case "create":
            if (IS_ANY) {
              if (party.roomId) return { ok: true, invite: inviteLink() };
              anyV.resetAsk();
              const r = await anyFind(async () => {
                await createParty();
                ui.show();
              });
              if (r.none) throw new Error(NO_VIDEO);
              return { ...r, invite: inviteLink() };
            }
            await createParty();
            return { ok: true, invite: inviteLink() };
          case "findVideo": {
            // the popup allowed a cross-origin player: look again (the agent says hello once it's in)
            if (!IS_ANY) return { ok: true };
            for (let t = 0; t < 3000 && !anyV.ready; t += 250) await sleep(250);
            return { ok: anyV.ready, frameHint: anyV.frameHint };
          }
          case "join": {
            // from the popup: the full invite link's code and key
            const code = String(msg.roomId || "").trim().toLowerCase();
            if (!/^[a-z0-9]{4,16}$/.test(code)) throw new Error("That doesn't look like a NetParty invite link.");
            if (!e2e.validKey(msg.key)) throw new Error(E2E.NEED_LINK);
            await keys.set(code, msg.key);
            if (IS_ANY && party.roomId === code) return { ok: true };
            await joinParty(code);
            if (IS_ANY && party.roomId) {
              anyV.resetAsk();
              const r = await anyFind(async () => {});
              if (r.none) ui.system(NO_VIDEO + " Play the video, or open the page it's on.");
              return { ...r, none: undefined, ok: true };
            }
            return { ok: true };
          }
          case "leave":
            await leaveParty({ end: true });
            return { ok: true };
          case "hostOnly":
            await net.request("settings", { hostOnly: !!msg.value });
            return { ok: true };
          case "lock":
            // 2.3: from the popup (host only; the server checks)
            try {
              await hostCtl.lock(!!msg.value);
            } catch (e) {
              throw new Error(hostErr(e));
            }
            return { ok: true };
          case "showChat":
            ui.show();
            return { ok: true };
        }
      } catch (e) {
        return { error: e.message };
      }
    })().then(sendResponse);
    return true;
  });

  // ------------------------------------------------------------- boot
  (async () => {
    await loadPrefs();
    const params = new URLSearchParams(location.search);
    if (params.has("npParty") || params.has("npStart")) {
      params.delete("npParty");
      params.delete("npStart");
      const q = params.toString();
      history.replaceState(history.state, "", location.pathname + (q ? "?" + q : "") + location.hash);
    }
    const room = sessionStorage.getItem("netpartyRoom");
    if (!room) return void (booted = true); // invites and "Start a NetParty" are handled by partyLifecycle()
    busy = true;
    try {
      // Prime Video: after a reload the title page opens first and its player a moment later
      // (autoplay=1 in the address bar); give it time before treating this as leaving the title
      if (IS_PRIME && primeTitlePath() && !videoIdFromUrl())
        for (let t = 0; t < 25000 && !videoIdFromUrl() && primeTitlePath(); t += 500) await sleep(500);
      if (videoIdFromUrl()) {
        // reload or episode change: take our seat back
        await waitForPlayer();
        await joinParty(room);
      } else {
        // we left the title with a full page load: close out the party properly
        await ensureConnected();
        const snap = await net.request("join", { roomId: room, e2ee: 1, cid: TAB_ID, hc: 1 });
        party.roomId = snap.roomId;
        party.me = snap.you;
        party.hostId = snap.hostId;
        const host = party.me === party.hostId;
        await leaveParty({ end: true, reason: host ? "You left the title, so the party ended." : "You left the party." });
      }
    } catch (e) {
      // 2.3: the party is gone for this tab (ended, the host removed us, or it's locked and our seat is gone):
      // its key and recap totals go too (resetParty only knows the party once we've joined it)
      const gone = /not found|ended|removed you|is locked/i.test(e.message);
      if (gone && !party.roomId) {
        keys.del(room);
        chrome.runtime.sendMessage({ cmd: "recap", op: "del", code: room }).catch(() => {});
        chrome.runtime.sendMessage({ cmd: "shareQr", op: "close" }).catch(() => {});
      }
      await voice.leave().catch(() => {});
      resetParty({ recap: !/removed you/i.test(e.message) });
      if (videoIdFromUrl())
        notice(/not found|ended/i.test(e.message) ? "That party has ended." : /removed you|is locked/i.test(e.message) ? e.message : "Couldn't rejoin: " + e.message);
    } finally {
      busy = false;
      booted = true;
    }
  })();
})();
