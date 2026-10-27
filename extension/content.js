// NetParty content script (Netflix, JioHotstar, YouTube, Prime Video). Owns: the party connection, clock sync,
// playback sync, text chat (emoji, GIFs, links), reactions, voice and video chat (WebRTC mesh) and the in-page overlay.
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
  // "pv:www.amazon.co.uk/gp/video/detail/<ASIN>"), while its player is open.
  // Same shapes as validVideoId in server/core.js: anything else is never turned into a link.
  const PRIME_HOSTS = [
    "www.primevideo.com",
    ...["com", "co.uk", "de", "co.jp", "in", "ca", "com.au", "fr", "it", "es", "com.br", "com.mx", "nl"].map((t) => "www.amazon." + t),
  ];
  const PV_RE = /^pv:([a-z0-9.-]+)(\/(?:detail|dp|gp\/video\/detail)\/[A-Za-z0-9._-]{6,100})$/;
  function validVideoId(v) {
    if (typeof v !== "string" || !v || v.length > 512) return false;
    if (/^\d{1,12}$/.test(v)) return true;
    if (v.startsWith("yt:")) return /^yt:[A-Za-z0-9_-]{11}$/.test(v);
    if (v.startsWith("hs:")) return /^hs:(\/[A-Za-z0-9._~%-]+)+\/\d{5,}\/watch$/.test(v);
    const pv = PV_RE.exec(v);
    if (pv) return pv[1] === "www.primevideo.com" ? !pv[2].startsWith("/gp/") : PRIME_HOSTS.includes(pv[1]) && pv[2].startsWith("/gp/video/detail/");
    return false;
  }
  const IS_HOTSTAR = /(^|\.)(jio)?hotstar\.com$/.test(location.hostname);
  const IS_YT = /(^|\.)youtube\.com$/.test(location.hostname);
  const IS_PRIME = PRIME_HOSTS.includes(location.hostname);
  const SITE_NAME = IS_HOTSTAR ? "JioHotstar" : IS_YT ? "YouTube" : IS_PRIME ? "Prime Video" : "Netflix";
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
  const videoIdFromUrl = () => {
    if (IS_PRIME) {
      const t = primeTitlePath();
      const v = t && "pv:" + location.hostname + t;
      return v && validVideoId(v) && primePlayer() ? v : null;
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
    v && v.startsWith("hs:") ? "hs:" + (v.match(/(\d+)\/watch$/) || [])[1] : v && v.startsWith("pv:") ? "pv:" + v.split("/").pop() : v;
  const sameVideo = (a, b) => videoKey(a) === videoKey(b);
  // null for anything that isn't a known title shape (a party member can't send us elsewhere)
  const watchUrl = (videoId, roomId) => {
    if (!validVideoId(videoId) || !/^[a-z0-9]{4,16}$/.test(String(roomId))) return null;
    if (videoId.startsWith("yt:")) return `https://www.youtube.com/watch?v=${videoId.slice(3)}&npParty=${roomId}`;
    // Prime Video: autoplay=1 opens the player on the title page
    if (videoId.startsWith("pv:")) return `https://${videoId.slice(3)}?autoplay=1&npParty=${roomId}`;
    return (videoId.startsWith("hs:") ? "https://www.hotstar.com" + videoId.slice(3) : `https://www.netflix.com/watch/${videoId}`) + `?npParty=${roomId}`;
  };
  const HAS_ADS = IS_YT || IS_PRIME;
  // YouTube and Prime Video play ads in the main player: no sync while one is on screen
  const adPlaying = () => {
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
    if (IS_PRIME) {
      const box = primePlayer()?.box;
      t = box?.querySelector('[class*="atvwebplayersdk-title-text"]')?.textContent || "";
      if (!t.trim()) t = document.querySelector('meta[property="og:title"]')?.content || document.querySelector("h1")?.textContent || "";
      t = t.replace(/^(watch|prime video:)\s+/i, "").replace(/\s*[|–-]\s*(prime video|amazon\.\S+).*$/i, "");
    } else if (IS_YT) {
      t = document.querySelector("ytd-watch-metadata h1, h1.ytd-watch-metadata, #above-the-fold #title h1")?.textContent || "";
      if (!t.trim()) t = document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube\s*$/i, "");
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
  const mainVideo = () => (IS_PRIME ? primePlayer()?.video || null : largest([...document.querySelectorAll("video")]));
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
  const CT_MAX = { chat: ctChars(pad64(500 * 6 + 64)), profile: ctChars(pad64(24 * 2 * 6 + 16 * 6 + 64)), react: ctChars(pad64(16 * 6 + 32)), signal: 32768 };
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
  // decrypted chat payload -> { text } or { gif: { url, w, h } }, or null if it isn't valid
  function cleanChat(p) {
    if (p?.t === "gif") return isKlipyMediaUrl(p.url) ? { gif: { url: p.url, w: dim(p.w), h: dim(p.h) } } : null;
    if (p?.t === "text" && typeof p.text === "string") {
      const text = p.text.trim().slice(0, 500);
      return text ? { text } : null;
    }
    return null;
  }
  const cleanProfile = (p) => ({ name: cleanName(p?.name) || "Guest", avatar: cleanAvatar(p?.avatar) });

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

  // ------------------------------------------------- page-context bridge
  const bridge = (() => {
    // YouTube: a plain HTML5 <video> in #movie_player, driven straight from here. (No page
    // script needed, which matters because youtube.com enforces a nonce-based script-src.)
    // Prime Video: the HTML5 <video> in its overlay player, the same way.
    if (IS_YT || IS_PRIME) {
      const v = IS_PRIME
        ? () => primePlayer()?.video || null
        : () => document.querySelector("#movie_player video.html5-main-video") || document.querySelector("#movie_player video") || mainVideo();
      const status = () => {
        const x = v();
        if (!x) return null;
        return {
          position: Math.round((x.currentTime || 0) * 1000),
          playing: !x.paused,
          buffering: x.readyState < 3 && !x.paused,
          duration: Math.round((x.duration || 0) * 1000),
        };
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
    members: [],
    state: null, // { playing, position, at (server ms), videoId, by }
    profiles: new Map(), // pid -> { name, avatar } (decrypted)
    profileCt: new Map(), // pid -> the ciphertext it came from
    name: "Guest",
    avatar: null,
    serverUrl: "wss://netparty.tech",
    error: null,
  };
  let suppressUntil = 0;
  let lastEpisodeChange = 0;
  let lastLocalAction = 0;
  let videoEl = null;

  const expectedPosition = (st) =>
    st.position + (st.playing ? Math.max(0, Date.now() - clock.toLocal(st.at)) : 0);

  async function loadPrefs() {
    const p = await chrome.storage.sync.get(["serverUrl", "name", "avatar", "chatFont", "reactions", "theme"]);
    party.serverUrl = p.serverUrl || party.serverUrl;
    party.name = p.name || party.name;
    party.avatar = p.avatar || null;
    ui.setFont(p.chatFont);
    ui.setReactions(p.reactions);
    ui.setTheme(p.theme);
  }

  chrome.storage.onChanged.addListener((ch, area) => {
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
    }
    if (ch.chatFont) ui.setFont(ch.chatFont.newValue);
    if (ch.theme) ui.setTheme(ch.theme.newValue);
    if (ch.reactions) ui.setReactions(ch.reactions.newValue);
    if (ch.serverUrl) party.serverUrl = ch.serverUrl.newValue;
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

  // our encrypted { name, avatar }, sent after every join and whenever it changes
  async function sendProfile() {
    if (!party.roomId || !party.me || !e2e.ready) return;
    const mine = { name: cleanName(party.name) || "Guest", avatar: cleanAvatar(party.avatar) };
    party.profiles.set(party.me, mine);
    try {
      const ct = await e2e.seal("profile", party.me, mine);
      if (ct.length > CT_MAX.profile) return;
      await net.request("profile", { ct });
    } catch {}
  }
  // the party's info from a peek/join/create reply: is it encrypted, and is our key its key?
  async function verifyParty(info, key) {
    if (!info?.e2ee) throw new Error(info?.roomId && !("kc" in info) ? E2E.OLD_SERVER : E2E.OLD_ROOM);
    if (!(await e2e.checkKey(key, info.kc))) throw new Error(E2E.BAD_KEY);
  }

  async function createParty() {
    const vid = videoIdFromUrl();
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
      kc: await e2e.makeCheck(),
      videoId: vid,
      playing: st.playing,
      position: st.position,
      at: clock.serverNow(),
    });
    try {
      if (!snap?.e2ee || typeof snap.roomId !== "string") throw new Error(E2E.OLD_SERVER);
      e2e.setRoom(snap.roomId);
      await keys.set(snap.roomId, key);
      await inbound(() => onJoined(snap));
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
    if (!videoIdFromUrl()) {
      // not on a player yet (browse page): go to the party's title; the invite code
      // rides along in the URL (the key stays in this tab's extension storage) and the join happens there
      const url = info.videoId && watchUrl(info.videoId, info.roomId);
      if (!url) throw new Error("The host hasn't opened a title yet.");
      net.stop();
      location.href = url;
      return info;
    }
    await e2e.use(info.roomId, key);
    const snap = await net.request("join", { roomId, e2ee: 1, cid: TAB_ID });
    try {
      await inbound(() => onJoined(snap, key));
    } catch (e) {
      net.request("leave", {}, 3000).catch(() => {});
      e2e.clear();
      throw e;
    }
    if (!snap.returning) ui.system("You joined the party.");
    await applyRemote(snap.state, "join");
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

  function resetParty() {
    if (party.roomId) keys.del(party.roomId);
    party.roomId = null;
    party.me = null;
    party.hostId = null;
    party.members = [];
    party.state = null;
    party.profiles.clear();
    party.profileCt.clear();
    e2e.clear();
    net.stop();
    for (const k of ["netpartyRoom", "netpartyVoice", "netpartyPanel"]) sessionStorage.removeItem(k);
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
    (document.fullscreenElement || document.body).append(noticeHost);
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
    if (h?.kind === "system" || h?.event) return h.event === "join" || h.event === "leave" ? { kind: "system", event: h.event, id: String(h.id), ts: h.ts } : null;
    if (typeof h?.from !== "string") return null;
    const p = await e2e.open("chat", h.from, h.ct);
    if (!p) {
      cantDecrypt();
      return null;
    }
    const c = cleanChat(p);
    return c && { kind: "chat", id: h.from, ts: h.ts, ...c };
  }

  // A create/join/rejoin reply: the party, its members and history (decrypted here). Runs in
  // the inbound queue so live messages that follow it are shown after the history.
  async function onJoined(snap, key = e2e.keyStr) {
    if (!snap?.e2ee) throw new Error(E2E.OLD_SERVER);
    if (!(await e2e.checkKey(key, snap.kc))) throw new Error(E2E.BAD_KEY);
    party.roomId = snap.roomId;
    party.me = snap.you;
    party.hostId = snap.hostId;
    party.hostOnly = snap.hostOnly;
    party.members = Array.isArray(snap.members) ? snap.members : [];
    party.state = snap.state;
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
    ui.loadHistory(lines);
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
    if (st.videoId && !sameVideo(vid, st.videoId)) {
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
    suppressUntil = Math.max(suppressUntil, Date.now() + SUPPRESS_MS);
    const target = expectedPosition(st);
    if (Math.abs(target - cur.position) >= SEEK_THRESHOLD_MS) await bridge.seek(target);
    if (st.playing && !cur.playing) await bridge.play();
    if (!st.playing && cur.playing) await bridge.pause();
    suppressUntil = Math.max(suppressUntil, Date.now() + SUPPRESS_MS);
    log("applied remote", reason, st);
  }

  let sendTimer = null;
  function onLocalPlayerEvent(kind) {
    if (HAS_ADS) adWatch(); // an ad that just ended: the resume events below are the site's, not ours
    if (!party.roomId || Date.now() < suppressUntil || adPlaying()) return;
    // coalesce bursts (Netflix fires pause+seeked+play when scrubbing)
    clearTimeout(sendTimer);
    sendTimer = setTimeout(async () => {
      if (HAS_ADS) adWatch();
      if (Date.now() < suppressUntil || adPlaying()) return; // an ad started, or a remote action is being applied
      const st = await bridge.status();
      if (!st || !party.roomId || !Number.isFinite(st.position) || !videoIdFromUrl() || adPlaying()) return;
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
      };
      // only count it once the server took it (a rejected update must not hide an
      // episode change from the check in watchPlayer)
      net.request("state", state).then(() => (party.state = state), (e) => ui.system(e.message));
    }, 250);
  }

  // periodic drift correction
  setInterval(async () => {
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
  const LEAVE_GRACE_MS = IS_PRIME ? 6000 : 2500;
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
          const what = { play: "played", pause: "paused", seeked: "jumped to " + fmt(msg.data.position), episode: IS_YT ? "changed the video" : IS_PRIME ? "changed the title" : "changed the episode" }[msg.data.reason];
          if (what) ui.system(`${nameOf(msg.data.by)} ${what}`);
        }
        applyRemote(msg.data, "remote");
        break;
      case "members":
        if (!party.roomId || !Array.isArray(msg.data.members)) break;
        party.members = msg.data.members;
        party.hostId = msg.data.hostId;
        if (await absorbProfiles(party.members.map((m) => [m.id, m.profile]))) ui.refreshNames();
        ui.render();
        break;
      case "settings":
        party.hostOnly = msg.data.hostOnly;
        ui.render();
        break;
      case "chat": {
        if (!party.roomId) break;
        const line = await decodeLine(msg.data);
        // the same ciphertext twice (a replay) is shown once
        if (line && !seenCt.has(msg.data.ct)) {
          seenCt.add(msg.data.ct);
          ui.chat(line);
        }
        break;
      }
      case "react": {
        if (!party.roomId || typeof msg.data.from !== "string") break;
        const p = await e2e.open("react", msg.data.from, msg.data.ct);
        if (p && isSingleEmoji(p.e, 16)) ui.float(p.e);
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
            const snap = await net.request("join", { roomId: room, e2ee: 1, cid: TAB_ID });
            await onJoined(snap); // already in the inbound queue
            ui.system("Reconnected.");
            applyRemote(snap.state, "rejoin");
            if (voice.active) voice.rejoin().catch(() => {});
          } catch (e) {
            if (/not found|ended/i.test(e.message)) {
              resetParty();
              notice("That party has ended.");
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
  // (DTLS-SRTP). No TURN server yet: behind some networks (symmetric NAT, strict campus Wi-Fi)
  // peers can't reach each other and that link fails.
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
    // id -> { pc, audio, pendingIce: [], sendQ, vt (video transceiver), video (their camera track),
    //        camOn (their camera is on), v18 (they run 1.8+: sent us a cam message or offered video) }
    const peers = new Map();
    const peerState = new Map(); // id -> { muted, speaking }
    const rxQ = new Map(); // id -> chain of incoming signals being handled
    let muted = false;
    let speaking = false;
    let meter = null;
    let volume = 1;
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
      const audio = new Audio();
      audio.autoplay = true;
      audio.volume = volume;
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
        if (pc.connectionState === "failed") {
          ui.system("Voice/video link to " + nameOf(id) + " failed: your networks may block peer-to-peer connections (there's no relay server yet).");
        }
        if (pc.connectionState === "connected") {
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
        if (res.iceServers?.length) iceServers = res.iceServers;
        // newcomer calls everyone already in voice (one side offers, so no glare)
        for (const id of res.peers) callPeer(id).catch((e) => log("call failed", e));
        ui.system("You joined voice chat. Headphones avoid echo.");
        ui.render();
      },
      async rejoin() {
        for (const id of [...peers.keys()]) closePeer(id);
        const res = await net.request("voiceJoin", {});
        for (const id of res.peers) callPeer(id).catch(() => {});
      },
      async leave() {
        sessionStorage.removeItem("netpartyVoice");
        if (!active) return;
        active = false;
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
        for (const p of peers.values()) p.audio.volume = v;
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
          if (entry) closePeer(from);
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

  // ------------------------------------------------------------------ UI
  // Lives in a shadow root so the streaming site's CSS can't break it.
  const ui = (() => {
    const E = globalThis.NP_EMOJI || { avatars: ["🙂"], reactions: ["😂", "😭", "💀", "🥰", "😱"], categories: [] };
    let host, shadow, root, panel, peopleEl, chatEl, input, sendBtn, codeEl, metaEl, voiceBox, toggleBtn, badge, toastEl;
    let composer, floatLayer, emojiBtn, gifBtn, reactBtn, fontBtn, camLayer;
    let open = false;
    let unread = 0;
    let toastTimer = 0;
    let peopleSig = "";

    const hue = (id) => [...String(id)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
    // a member's picture (from their decrypted profile); none yet: a stable one from their id
    const picOf = (pid) =>
      (pid === party.me ? cleanAvatar(party.avatar) : party.profiles.get(pid)?.avatar) || E.avatars[hue(pid || "?") % E.avatars.length];
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
      smile: '<path fill="none" stroke="currentColor" stroke-width="2" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M8 14.5a5 5 0 0 0 8 0"/><path fill="currentColor" d="M9 8.5a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm6 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/>',
      edit: '<path fill="currentColor" d="M3 17.2V21h3.8L17.8 9.9l-3.7-3.7zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7z"/>',
      clock: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4v5l3 2"/>',
      cam: '<path fill="currentColor" d="M4 6h11a2 2 0 0 1 2 2v1.6l4-2.6v10l-4-2.6V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/>',
      camOff: '<path fill="currentColor" d="M3.3 2 2 3.3 4.7 6H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h11c.4 0 .8-.1 1.1-.3l4.6 4.6 1.3-1.3zM21 7l-4 2.6V8a2 2 0 0 0-2-2H9.2L21 17.8z"/>',
      chevron: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/>',
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
    function sendChat() {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      lastSel = null;
      updateSend();
      sendLine({ t: "text", text: text.slice(0, 500) }).catch((err) => system("Message not sent: " + err.message));
      input.focus();
    }
    // chat text or GIF, encrypted for the party
    async function sendLine(payload) {
      if (!party.roomId || !party.me || !e2e.ready) throw new Error("Not in a party.");
      const ct = await e2e.seal("chat", party.me, payload);
      if (ct.length > CT_MAX.chat) throw new Error("Too long.");
      await net.request("chat", { ct });
    }
    const updateSend = () => (sendBtn.disabled = !input.value.trim());

    // keys typed in the panel arrive here first (early.js), before the site's hotkeys
    window.__netpartyKey = (e) => {
      if (e.isComposing || !shadow) return;
      const active = shadow.activeElement;
      if (e.key === "Enter" && !e.shiftKey && active === input) {
        e.preventDefault();
        sendChat();
      } else if (e.key === "Enter" && active === gif.inputEl) {
        e.preventDefault();
        gif.searchNow();
      } else if (e.key === "Escape") {
        if (pops.current) {
          e.preventDefault();
          pops.close();
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

    // ---- emoji picker
    const emoji = (() => {
      let node, body, recentSec, recentGrid, mode = null; // mode: null (insert) or { slot }
      let recent = [];
      chrome.storage.local.get("recentEmoji").then((r) => (recent = Array.isArray(r.recentEmoji) ? r.recentEmoji.slice(0, 16) : [])).catch(() => {});
      const btn = (e) =>
        keepFocus(el("button", { type: "button", class: "np-emo-btn np-emo", title: e, "aria-label": e, "data-emoji": e, onclick: () => pick(e) }, e));
      function pick(e) {
        recent = [e, ...recent.filter((x) => x !== e)].slice(0, 16);
        chrome.storage.local.set({ recentEmoji: recent }).catch(() => {});
        if (mode) {
          const slot = mode.slot;
          pops.close();
          reactions.replace(slot, e);
          return;
        }
        insertAtCursor(e);
        fillRecent();
      }
      function fillRecent() {
        if (!recentGrid) return;
        recentGrid.replaceChildren(...recent.map(btn));
        recentSec.hidden = !recent.length;
      }
      function build() {
        body = el("div", { class: "np-emo-body" });
        const tabs = el("div", { class: "np-emo-tabs", role: "tablist" });
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
        tabs.append(tab("recent", "🕘", "Recently used"));
        for (const c of E.categories) {
          body.append(section(c.id, c.label, c.list)[0]);
          tabs.append(tab(c.id, c.icon, c.label));
        }
        node = popEl("np-emoji-pop", "Emoji", tabs, body);
        node.addEventListener("np-close", () => {
          mode = null;
          node.classList.remove("np-replace");
          emojiBtn.classList.remove("np-on");
          reactBtn.classList.remove("np-on");
        });
        panel.append(node);
      }
      return {
        // forSlot: pick a replacement for that 🎉 tray slot instead of typing the emoji
        toggle(forSlot = null) {
          if (!node) build();
          fillRecent();
          const want = forSlot === null ? null : { slot: forSlot };
          if (pops.current === node && !want && !mode) return pops.close();
          pops.close();
          pops.open(node, want ? reactBtn : emojiBtn);
          mode = want;
          node.classList.toggle("np-replace", !!mode);
          node.setAttribute("aria-label", mode ? "Pick a reaction" : "Emoji");
          (mode ? reactBtn : emojiBtn).classList.add("np-on");
          body.scrollTop = 0;
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

    // ---- your profile picture (also in the popup)
    const avatarPicker = (() => {
      let node;
      return {
        toggle(anchor) {
          if (!node) {
            node = popEl(
              "np-avatar-pop",
              "Your picture",
              el("div", { class: "np-pop-title" }, "Your picture"),
              el(
                "div",
                { class: "np-avatar-grid" },
                ...E.avatars.map((a) =>
                  el("button", {
                    type: "button", class: "np-avatar-opt np-emo", title: a, "aria-label": "Use " + a, "data-avatar": a,
                    onclick: () => {
                      pops.close();
                      party.avatar = a; // the storage listener tells the server
                      chrome.storage.sync.set({ avatar: a }).catch(() => {});
                      peopleSig = "";
                      render();
                    },
                  }, a),
                ),
              ),
            );
            panel.append(node);
          }
          for (const b of node.querySelectorAll(".np-avatar-opt")) b.classList.toggle("np-on", b.dataset.avatar === party.avatar);
          pops.open(node, anchor, peopleEl.offsetTop + peopleEl.offsetHeight);
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

    // ---- camera tiles: a small floating, draggable, collapsible strip over the video
    const camUi = (() => {
      let body, countEl, collapseBtn;
      const tiles = new Map(); // id -> { node, video, track, label, pic }
      let pos = null, collapsed = false;
      try {
        const saved = JSON.parse(sessionStorage.getItem("netpartyCams") || "null");
        if (saved && typeof saved === "object") {
          collapsed = !!saved.collapsed;
          if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) pos = { x: saved.x, y: saved.y };
        }
      } catch {}
      const save = () => sessionStorage.setItem("netpartyCams", JSON.stringify({ collapsed, ...(pos || {}) }));
      // keep it on screen; it may sit over the video or over the docked chat, wherever the user drops it
      function clamp() {
        if (!pos || !camLayer || camLayer.hidden) return;
        const r = camLayer.getBoundingClientRect();
        const maxX = innerWidth - r.width - 4;
        pos.x = Math.round(Math.max(4, Math.min(pos.x, maxX)));
        pos.y = Math.round(Math.max(4, Math.min(pos.y, innerHeight - r.height - 4)));
        camLayer.style.left = pos.x + "px";
        camLayer.style.top = pos.y + "px";
        camLayer.style.bottom = "auto";
      }
      function setCollapsed(v) {
        collapsed = v;
        camLayer.classList.toggle("np-cams-min", collapsed);
        collapseBtn.setAttribute("aria-expanded", String(!collapsed));
        collapseBtn.title = collapsed ? "Show cameras" : "Hide cameras";
        collapseBtn.setAttribute("aria-label", collapseBtn.title);
        save();
        requestAnimationFrame(clamp);
      }
      function build() {
        countEl = el("span", { class: "np-cams-count" });
        collapseBtn = el("button", { type: "button", class: "np-cams-btn", onclick: () => setCollapsed(!collapsed) }, svg(ICON.chevron));
        const bar = el("div", { class: "np-cams-bar", title: "Drag to move" }, svg(ICON.cam), countEl, el("span", { class: "np-grow" }), collapseBtn);
        body = el("div", { class: "np-cams-body" });
        camLayer = el("div", { class: "np-cams", role: "region", "aria-label": "Cameras", hidden: "" }, bar, body);
        // drag by the bar
        let drag = null;
        bar.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || e.target.closest("button")) return;
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
        // clicks and drags on the tiles must not reach the player (pause, seek, fullscreen)
        for (const evt of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel", "contextmenu"]) camLayer.addEventListener(evt, (e) => e.stopPropagation());
        addEventListener("resize", () => requestAnimationFrame(clamp));
        setCollapsed(collapsed);
      }
      function tile(id, self) {
        const video = el("video", { class: "np-cam-video" + (self ? " np-self" : ""), autoplay: "", playsinline: "", "aria-hidden": "true" });
        video.muted = true; // voices play through the voice chat's own audio
        const pic = el("div", { class: "np-cam-pic np-emo", "aria-hidden": "true" });
        const label = el("div", { class: "np-cam-name" });
        const node = el("div", { class: "np-cam", "data-uid": id }, pic, video, label);
        return { node, video, pic, label, track: null };
      }
      function render() {
        if (!camLayer) build();
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
        camLayer.hidden = !list.length;
        if (!list.length) return;
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
          if (t.label.textContent !== name) t.label.textContent = name;
          const p = picOf(c.id);
          if (t.pic.textContent !== p) t.pic.textContent = p;
          t.pic.style.setProperty("--h", hue(c.id));
          t.node.title = c.live ? name : name + " · connecting video…";
          body.append(t.node); // keeps the order: you first
        }
        countEl.textContent = list.length === 1 ? "1 camera" : list.length + " cameras";
        requestAnimationFrame(clamp);
      }
      return { render };
    })();

    function build() {
      host = el("div", { id: "netparty-root" });
      shadow = host.attachShadow({ mode: "open" });
      shadow.append(el("link", { rel: "stylesheet", href: chrome.runtime.getURL("overlay.css") }));

      badge = el("span", { class: "np-badge" });
      toggleBtn = el("button", { type: "button", class: "np-toggle", title: "Party chat (NetParty)", "aria-label": "Party chat (NetParty)", onclick: () => (open ? hide() : show()) }, svg(ICON.chat), badge);
      toastEl = el("div", { class: "np-toast", onclick: show });
      floatLayer = el("div", { class: "np-float", "aria-hidden": "true" });

      codeEl = el("span", { class: "np-code" });
      metaEl = el("div", { class: "np-meta" });
      const copyBtn = el(
        "button",
        {
          type: "button",
          class: "np-pill",
          onclick: async () => {
            const link = inviteLink();
            if (!link) return;
            await navigator.clipboard.writeText(link).catch(() => {});
            copyBtn.lastChild.textContent = "Copied!";
            setTimeout(() => (copyBtn.lastChild.textContent = "Copy invite"), 1500);
          },
        },
        svg(ICON.link),
        el("span", {}, "Copy invite"),
      );
      const head = el(
        "div",
        { class: "np-head" },
        el("div", { class: "np-title" }, el("div", { class: "np-brand" }, "NetParty ", codeEl), metaEl),
        iconBtn(ICON.close, "Hide chat (Esc)", hide, "np-close"),
      );

      peopleEl = el("div", { class: "np-people" });
      voiceBox = el("div", { class: "np-voice" });
      chatEl = el("div", { class: "np-chat", role: "log", "aria-live": "polite" });

      input = el("input", { class: "np-input", type: "text", placeholder: "Message the party…", "aria-label": "Message the party", maxlength: "500", autocomplete: "off" });
      input.addEventListener("input", updateSend);
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
      for (const b of [emojiBtn, gifBtn, reactBtn, fontBtn]) keepFocus(b);
      composer = el(
        "form",
        { class: "np-composer", onsubmit: (e) => (e.preventDefault(), sendChat()) },
        el("div", { class: "np-tools" }, emojiBtn, gifBtn, reactBtn, el("span", { class: "np-grow" }), fontBtn),
        el("div", { class: "np-row" }, input, sendBtn),
      );

      const leaveBtn = el(
        "button",
        {
          type: "button",
          class: "np-link-btn",
          onclick: () => {
            const isHost = party.me === party.hostId;
            if (confirm(isHost ? "End the party for everyone?" : "Leave this party?")) leaveParty({ end: true });
          },
        },
        "Leave party",
      );

      panel = el(
        "aside",
        { class: "np-panel", "aria-label": "NetParty chat" },
        head,
        el("div", { class: "np-actions" }, copyBtn, leaveBtn),
        el("div", { class: "np-section-label" }, "Watching"),
        peopleEl,
        voiceBox,
        chatEl,
        composer,
      );
      // keep clicks and scrolls inside the panel from reaching the player
      for (const evt of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel", "contextmenu"])
        panel.addEventListener(evt, (e) => e.stopPropagation());
      camUi.render(); // builds the (hidden) camera strip
      root = el("div", { class: "np-root" }, floatLayer, camLayer, toggleBtn, toastEl, panel);
      shadow.append(root);
      setFont(font);
      setTheme(theme);
      reactions.set(reactionPref);
      shadow.addEventListener("pointerdown", (e) => pops.outside(e.composedPath()), true);
      document.addEventListener("pointerdown", (e) => !e.composedPath().includes(host) && pops.close(), true);
      document.addEventListener("fullscreenchange", () => {
        mount();
        dockCheck(true);
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
      for (const sel of PLAYER_BOX[IS_HOTSTAR ? "hotstar" : IS_PRIME ? "prime" : "netflix"] || []) {
        const n = document.querySelector(sel);
        if (n && n.getBoundingClientRect().width > 0) return n;
      }
      // generic: the outermost full-width ancestor of the video, below the page root
      const top = document.fullscreenElement || document.body;
      const v = mainVideo();
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
        markShrinkTargets();
      }
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
      const parent = document.fullscreenElement || document.body;
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
      mount();
      root.classList.add("np-open");
      toastEl.classList.remove("np-show");
      peopleSig = voiceBox.dataset.sig = "";
      render();
      dockCheck();
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
      if (host) dockCheck();
    }

    function toast(name, text) {
      if (open) return;
      toastEl.replaceChildren(el("b", {}, name), " ", text.length > 80 ? text.slice(0, 80) + "…" : text);
      toastEl.classList.add("np-show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove("np-show"), 4000);
    }

    const metaText = () => {
      const st = party.state;
      if (!st) return "";
      if (adPlaying()) return "Waiting for ad to finish…";
      return `${st.playing ? "▶ Playing" : "❚❚ Paused"} at ${fmt(expectedPosition(st))}${party.hostOnly ? " · host controls playback" : ""}`;
    };

    function render() {
      if (!host) return;
      mount();
      badge.textContent = unread > 9 ? "9+" : unread ? String(unread) : "";
      badge.style.display = unread ? "" : "none";
      codeEl.textContent = party.roomId ? "· " + party.roomId : "";
      metaEl.textContent = metaText();
      metaEl.classList.toggle("np-ad", adPlaying());

      const pSig = party.members
        .map((m) => {
          const isMe = m.id === party.me;
          const info = isMe ? { muted: voice.muted, speaking: voice.speaking } : voice.peerInfo(m.id);
          return [m.id, nameOf(m.id), picOf(m.id), m.host, isMe ? voice.active : m.inVoice, info.muted, info.speaking, info.connected].join(":");
        })
        .join("|");
      if (pSig !== peopleSig) {
        peopleSig = pSig;
        peopleEl.replaceChildren(
          ...party.members.map((m) => {
            const isMe = m.id === party.me;
            const info = isMe ? { muted: voice.muted, speaking: voice.speaking } : voice.peerInfo(m.id);
            const inVoice = isMe ? voice.active : !!m.inVoice;
            const pic = picOf(m.id);
            const avatar = el("div", { class: "np-avatar np-emo", style: `--h:${hue(m.id)}` }, el("span", { class: "np-avatar-pic" }, pic));
            if (m.host) avatar.append(el("span", { class: "np-crown", title: "Host" }, svg(ICON.crown)));
            if (inVoice) avatar.append(el("span", { class: "np-mic" + (info.muted ? " np-off" : ""), title: info.muted ? "Muted" : "In voice" }, svg(info.muted ? ICON.micOff : ICON.mic)));
            const label = nameOf(m.id) + (m.host ? " (host)" : "");
            const tile = isMe
              ? el("button", { type: "button", class: "np-person np-me", title: "You · change your picture", "aria-label": "Change your picture", onclick: (e) => avatarPicker.toggle(e.currentTarget) })
              : el("div", { class: "np-person", title: label });
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

    function addLine(node) {
      if (!host) build();
      const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
      chatEl.append(node);
      while (chatEl.childElementCount > 200) {
        media.release(chatEl.firstElementChild);
        chatEl.firstElementChild.remove();
      }
      if (nearBottom || !open) chatEl.scrollTop = chatEl.scrollHeight;
    }

    // d: { id (sender pid), ts, text } or { id, ts, gif: { url, w, h } } (decrypted and checked)
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
      } else if (text) body = el("div", { class: "np-bubble" }, ...linkify(text), el("span", { class: "np-time" }, time));
      else return;
      // everyone's lines, ours included, carry the sender's picture and name (ours on the right)
      addLine(
        el(
          "div",
          { class: "np-msg" + (mine ? " np-mine" : "") },
          el("div", { class: "np-mav np-emo", "data-uid": d.id, style: `--h:${hue(d.id)}`, "aria-hidden": "true" }, picOf(d.id)),
          el("div", { class: "np-mcol" }, el("div", { class: "np-author", "data-uid": d.id, style: `--h:${hue(d.id)}` }, who), body),
        ),
      );
      if (!open && !mine && !replay) {
        unread++;
        toast(who, d.gif ? "sent a GIF" : text);
        render();
      }
    }
    // keep the newest message in view when a GIF above it finishes loading
    function nearBottomScroll() {
      if (chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 260) chatEl.scrollTop = chatEl.scrollHeight;
    }
    function system(text) {
      addLine(el("div", { class: "np-sys" }, text));
    }
    // "<name> joined / left", named from the member's decrypted profile (updates if it arrives later)
    function sysEvent(event, pid) {
      addLine(el("div", { class: "np-sys" }, el("span", { class: "np-who", "data-uid": pid }, nameOf(pid)), event === "join" ? " joined" : " left"));
    }
    function refreshNames() {
      if (!chatEl) return;
      for (const n of chatEl.querySelectorAll(".np-author[data-uid], .np-who[data-uid]")) {
        const v = nameOf(n.dataset.uid);
        if (n.textContent !== v) n.textContent = v;
      }
      for (const n of chatEl.querySelectorAll(".np-mav[data-uid]")) {
        const v = picOf(n.dataset.uid);
        if (n.textContent !== v) n.textContent = v;
      }
    }
    // everything said in the party so far (the server keeps the last 150 lines, encrypted)
    function loadHistory(list) {
      if (!host) build();
      media.release(chatEl);
      chatEl.replaceChildren();
      system("🔒 Chat is end-to-end encrypted. Only people with the invite link can read it.");
      for (const h of list) h.kind === "chat" ? chat(h, true) : sysEvent(h.event, h.id);
      chatEl.scrollTop = chatEl.scrollHeight;
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

  // ------------------------------------------------ popup <-> content API
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.cmd) {
          case "status":
            return {
              site: SITE_NAME,
              onWatchPage: !!videoIdFromUrl(),
              roomId: party.roomId,
              members: party.members.map((m) => nameOf(m.id)),
              invite: inviteLink(),
              hostOnly: party.hostOnly,
              isHost: party.me === party.hostId,
              voice: voice.active,
              chatOpen: false,
            };
          case "create":
            await createParty();
            return { ok: true, invite: inviteLink() };
          case "join": {
            // from the popup: the full invite link's code and key
            const code = String(msg.roomId || "").trim().toLowerCase();
            if (!/^[a-z0-9]{4,16}$/.test(code)) throw new Error("That doesn't look like a NetParty invite link.");
            if (!e2e.validKey(msg.key)) throw new Error(E2E.NEED_LINK);
            await keys.set(code, msg.key);
            await joinParty(code);
            return { ok: true };
          }
          case "leave":
            await leaveParty({ end: true });
            return { ok: true };
          case "hostOnly":
            await net.request("settings", { hostOnly: !!msg.value });
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
        const snap = await net.request("join", { roomId: room, e2ee: 1, cid: TAB_ID });
        party.roomId = snap.roomId;
        party.me = snap.you;
        party.hostId = snap.hostId;
        const host = party.me === party.hostId;
        await leaveParty({ end: true, reason: host ? "You left the title, so the party ended." : "You left the party." });
      }
    } catch (e) {
      resetParty();
      if (videoIdFromUrl()) notice(/not found/i.test(e.message) ? "That party has ended." : "Couldn't rejoin: " + e.message);
    } finally {
      busy = false;
      booted = true;
    }
  })();
})();
