// "Sync any video" (2.0): the generic video adapter for pages that aren't one of the supported services.
// Loaded only into a tab the user chose (after "Sync this tab" / "Join party on this tab", or on a site
// they allowed), before content.js.
//   * finds the page's <video> elements: in the page, in open shadow roots and in same-origin iframes
//   * picks the playing one, else the clearly largest visible one; when that's ambiguous, shows a
//     highlight overlay so the user clicks the one they mean
//   * notices videos inside cross-origin iframes (NetParty needs the user's OK for that frame's site)
//   * Theater mode: makes the video (or the iframe holding it) fill the window with inline styles
//     that are put back exactly as they were afterwards
// In a cross-origin iframe (injected there only after the user allowed that site) it runs as a small
// agent instead: it finds the frame's video and lets the tab's main NetParty script drive it through
// the extension's background (never through the page's own messaging).
(() => {
  if (globalThis.__npAnyLib) return;
  const TOP = window === window.top;
  const MIN_W = 120;
  const MIN_H = 68;

  const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const viewOf = (n) => n.ownerDocument?.defaultView || window;
  const styleOf = (n) => {
    try {
      return viewOf(n).getComputedStyle(n);
    } catch {
      return null;
    }
  };
  const isPlaying = (v) => !v.paused && !v.ended && v.readyState > 2;

  // every <video> reachable from this document (open shadow roots, same-origin frames), and the
  // iframes we can't look into (cross-origin)
  function scan(doc = document) {
    const videos = [];
    const xframes = [];
    const seen = new Set();
    const visit = (root, chain) => {
      if (seen.has(root)) return;
      seen.add(root);
      const d = root.ownerDocument || root;
      const walker = d.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const tag = n.localName;
        if (tag === "video") videos.push({ v: n, chain });
        if (n.shadowRoot) visit(n.shadowRoot, chain);
        if (tag === "iframe" || tag === "frame") {
          let fd = null;
          try {
            fd = n.contentDocument;
          } catch {}
          if (fd && fd.documentElement) visit(fd, [...chain, n]);
          else xframes.push({ el: n, chain });
        }
      }
    };
    visit(doc, []);
    return { videos, xframes };
  }

  // an element's box in this window's coordinates (adds the offsets of the frames it sits in)
  function topRect(el, chain = []) {
    const r = el.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    for (const f of chain) {
      const fr = f.getBoundingClientRect();
      x += fr.left + f.clientLeft;
      y += fr.top + f.clientTop;
    }
    return { left: x, top: y, width: r.width, height: r.height, right: x + r.width, bottom: y + r.height };
  }
  function shown(el, rect, chain = []) {
    if (rect.width < MIN_W || rect.height < MIN_H) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
    for (let n = el; n; n = parentOf(n)) {
      const cs = styleOf(n);
      if (!cs) break;
      if (cs.display === "none" || (n === el && cs.visibility === "hidden") || parseFloat(cs.opacity || "1") < 0.05) return false;
    }
    for (const f of chain) {
      const cs = styleOf(f);
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
    }
    return true;
  }
  const originOf = (frame) => {
    try {
      const u = new URL(frame.src || frame.getAttribute("src") || "", frame.ownerDocument.baseURI);
      return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  const area = (c) => c.rect.width * c.rect.height;

  // { list: visible video candidates, frames: visible cross-origin iframes big enough to hold a player }
  function candidates() {
    const { videos, xframes } = scan();
    const list = videos.map(({ v, chain }) => ({ v, chain, rect: topRect(v, chain) })).filter((c) => shown(c.v, c.rect, c.chain));
    const frames = xframes
      .map(({ el, chain }) => ({ el, chain, rect: topRect(el, chain), origin: originOf(el) }))
      .filter((f) => f.origin && f.origin !== location.origin && f.rect.width >= 200 && f.rect.height >= 112 && shown(f.el, f.rect, f.chain))
      .sort((a, b) => area(b) - area(a));
    return { list, frames };
  }
  // the playing video, else the clearly largest visible one; several similar ones -> ask the user
  // paused counts too: a video that has loaded media and been watched beats an empty or unstarted one
  const hasMedia = (v) => v.readyState >= 1 || !!v.currentSrc || !!v.srcObject;
  const started = (v) => hasMedia(v) && v.currentTime > 0 && !v.ended;
  const rank = (v) => (isPlaying(v) ? 4 : 0) + (started(v) ? 2 : 0) + (hasMedia(v) ? 1 : 0);
  const overlapRatio = (a, b) => {
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return (w * h) / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  };
  function choose(list) {
    if (!list.length) return { none: true };
    const tiers = [list.filter((c) => isPlaying(c.v)), list.filter((c) => started(c.v)), list.filter((c) => hasMedia(c.v)), list];
    const pool = tiers.find((t) => t.length).slice().sort((a, b) => area(b) - area(a));
    if (pool.length === 1 || area(pool[0]) >= 2.5 * area(pool[1])) return { pick: pool[0] };
    // players often stack two <video>s in one box (ad layer, preloader): take the better one of the pair
    if (overlapRatio(pool[0].rect, pool[1].rect) > 0.8 && pool.slice(2).every((c) => area(pool[0]) >= 2.5 * area(c))) {
      const [x, y] = pool;
      const best = rank(y.v) > rank(x.v) || (rank(y.v) === rank(x.v) && y.v.currentTime > x.v.currentTime) ? y : x;
      return { pick: best };
    }
    return { ambiguous: pool };
  }

  // ---- highlight overlay: "click the video you want to sync"
  let pickerOpen = null;
  function picker(list) {
    if (pickerOpen) pickerOpen.cancel();
    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.id = "netparty-picker";
      const sh = host.attachShadow({ mode: "open" });
      const css = document.createElement("style");
      css.textContent = `
:host{all:initial}
.wrap{position:fixed;inset:0;z-index:2147483647;background:rgba(10,8,20,.45);font:600 14px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.bar{position:fixed;top:16px;left:50%;transform:translateX(-50%);display:flex;gap:12px;align-items:center;background:#1b1b22;color:#f3f3f6;border:1px solid #7c5cff;border-radius:12px;padding:10px 12px 10px 16px;box-shadow:0 8px 30px #0008;max-width:calc(100vw - 32px)}
.bar b{color:#a48bff}
.box{position:fixed;box-sizing:border-box;border:3px solid #7c5cff;border-radius:10px;background:rgba(124,92,255,.16);cursor:pointer;display:grid;place-items:center;padding:0;margin:0;color:inherit;font:inherit;-webkit-tap-highlight-color:transparent;transition:background-color .12s,transform .12s}
.box span{background:#6C4CF5;color:#fff;border-radius:999px;padding:8px 14px;box-shadow:0 4px 18px #0006}
.box:active{transform:scale(.985);background:rgba(124,92,255,.3)}
.box:focus-visible{outline:3px solid #fff;outline-offset:2px}
.x{border:0;border-radius:8px;background:#2a2a34;color:#f3f3f6;font:inherit;padding:6px 12px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .12s}
.x:active{transform:scale(.96)}
@media (hover:hover){.box:hover{background:rgba(124,92,255,.32)}.x:hover{background:#383846}}
@media (prefers-reduced-motion:reduce){.box,.x{transition:none}}`;
      const wrap = document.createElement("div");
      wrap.className = "wrap";
      const bar = document.createElement("div");
      bar.className = "bar";
      const msg = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = "NetParty ";
      msg.append(b, "Click the video you want to watch together.");
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "x";
      cancel.textContent = "Cancel";
      bar.append(msg, cancel);
      const boxes = list.map((c, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "box";
        btn.setAttribute("aria-label", `Sync video ${i + 1}`);
        const s = document.createElement("span");
        s.textContent = list.length > 1 ? `Sync video ${i + 1}` : "Sync this video";
        btn.append(s);
        btn.addEventListener("click", () => done(c));
        return btn;
      });
      wrap.append(...boxes, bar);
      sh.append(css, wrap);
      const place = () => {
        list.forEach((c, i) => {
          const r = topRect(c.v, c.chain);
          Object.assign(boxes[i].style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
        });
      };
      place();
      const tick = setInterval(place, 400);
      // nothing in the overlay reaches the page (players pause or go fullscreen on clicks)
      for (const t of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "contextmenu"]) wrap.addEventListener(t, (e) => e.stopPropagation());
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopImmediatePropagation();
          e.preventDefault();
          done(null);
        }
      };
      window.addEventListener("keydown", onKey, true);
      cancel.addEventListener("click", () => done(null));
      function done(c) {
        clearInterval(tick);
        window.removeEventListener("keydown", onKey, true);
        host.remove();
        pickerOpen = null;
        resolve(c);
      }
      pickerOpen = { cancel: () => done(null) };
      (document.fullscreenElement && document.fullscreenElement.localName !== "video" ? document.fullscreenElement : document.body || document.documentElement).append(host);
      setTimeout(() => boxes[0]?.focus(), 30);
    });
  }

  // ---- Theater mode: inline !important styles, each element's old style attribute kept to put back
  const touched = []; // [element, old style attribute or null]
  const keep = (n) => {
    if (!touched.some(([x]) => x === n)) touched.push([n, n.getAttribute("style")]);
  };
  const put = (n, props) => {
    keep(n);
    for (const [k, v] of Object.entries(props)) n.style.setProperty(k, v, "important");
  };
  // fill: { width, height } as CSS lengths; the element is fixed to the top left of its own window
  function theaterOn(el, fill) {
    put(el, {
      position: "fixed", top: "0", left: "0", right: "auto", bottom: "auto", width: fill.width, height: fill.height,
      "max-width": "none", "max-height": "none", "min-width": "0", "min-height": "0", margin: "0", padding: "0",
      "z-index": "2147483646", background: "#000", "object-fit": "contain", transform: "none", border: "0",
      visibility: "visible", opacity: "1", "box-sizing": "border-box",
    });
    // ancestors that would trap a fixed element inside their box
    for (let n = parentOf(el); n && n.nodeType === 1; n = parentOf(n)) {
      const cs = styleOf(n);
      if (!cs) continue;
      if (cs.transform !== "none" || cs.filter !== "none" || cs.perspective !== "none" || (cs.backdropFilter && cs.backdropFilter !== "none") || /paint|layout|strict|content/.test(cs.contain || "") || /transform|filter|perspective/.test(cs.willChange || ""))
        put(n, { transform: "none", filter: "none", perspective: "none", "backdrop-filter": "none", contain: "none", "will-change": "auto" });
    }
    const d = el.ownerDocument;
    put(d.documentElement, { overflow: "hidden" });
    if (d.body) put(d.body, { overflow: "hidden" });
  }
  function theaterResize(el, fill) {
    if (touched.some(([x]) => x === el)) {
      el.style.setProperty("width", fill.width, "important");
      el.style.setProperty("height", fill.height, "important");
    }
  }
  function theaterOff() {
    for (const [n, old] of touched.splice(0).reverse()) {
      if (old === null) n.removeAttribute("style");
      else n.setAttribute("style", old);
    }
  }

  globalThis.__npAnyLib = { scan, candidates, choose, picker, topRect, shown, isPlaying, theaterOn, theaterOff, theaterResize, cancelPicker: () => pickerOpen?.cancel() };

  if (TOP) return;

  // ------------------------------------------------ agent in a cross-origin iframe
  // Talks only to the extension (chrome.runtime): the tab's main NetParty script asks for status and
  // sends play / pause / seek / speed through the background, and gets this video's events back.
  let video = null;
  let expectRate = null; // a speed we set ourselves (drift nudge), not the viewer's choice
  const send = (m) => chrome.runtime.sendMessage({ cmd: "npFrame", ...m }).catch(() => {});
  const EVENTS = ["play", "pause", "seeked", "ratechange", "durationchange", "emptied"];
  const onEvt = (e) => {
    if (e.type === "ratechange" && expectRate !== null && Math.abs(video.playbackRate - expectRate) < 1e-3) return;
    send({ op: "event", kind: e.type, rate: video?.playbackRate });
  };
  function attach(v) {
    if (v === video) return;
    if (video) for (const t of EVENTS) video.removeEventListener(t, onEvt);
    video = v;
    if (!v) return;
    for (const t of EVENTS) v.addEventListener(t, onEvt);
    send({ op: "hello", w: innerWidth, h: innerHeight });
  }
  // 2.2: say hello again now and then, so a main script that loaded after this frame (Crunchyroll's player
  // frame comes up before the page's NetParty script) still finds us. Marked "again": nothing re-syncs.
  setInterval(() => video && video.isConnected && send({ op: "hello", again: true, w: innerWidth, h: innerHeight }), 3000);
  // 2.2: an ad on screen in this frame (Crunchyroll's player). Built from public page structure, checked
  // against test pages only.
  const AD_SEL = '[data-testid*="ad-indicator" i], [class*="ad-indicator" i], [title="Advertisement"]';
  const adShown = () =>
    [...document.querySelectorAll(AD_SEL)].some((n) => {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && (!!n.textContent.trim() || n.localName === "video");
    });
  function find() {
    if (video && video.isConnected) return;
    const { list } = candidates();
    const c = choose(list);
    attach(c.pick?.v || c.ambiguous?.[0]?.v || null);
    if (!video) send({ op: "lost" });
  }
  find();
  setInterval(find, 1000);
  new MutationObserver(() => video && !video.isConnected && find()).observe(document.documentElement, { childList: true, subtree: true });
  let theater = false;
  addEventListener("resize", () => theater && video && theaterResize(video, { width: "100vw", height: "100vh" }));
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.cmd !== "npAgent") return;
    (async () => {
      if (!video || !video.isConnected) find();
      const v = video;
      if (!v) return null;
      switch (msg.op) {
        case "status":
          return {
            position: Math.round((v.currentTime || 0) * 1000),
            playing: !v.paused,
            buffering: v.readyState < 3 && !v.paused,
            // messages are JSON: a live stream's Infinity would arrive as null
            duration: v.duration === Infinity ? -1 : Math.round((v.duration || 0) * 1000),
            live: v.duration === Infinity,
            ready: v.readyState >= 3,
            ad: adShown(),
            rate: v.playbackRate,
            w: innerWidth,
            h: innerHeight,
          };
        case "seek":
          if (Number.isFinite(msg.position)) v.currentTime = Math.max(0, msg.position) / 1000;
          return { ok: true };
        case "play":
          await v.play()?.catch(() => {});
          return { ok: true };
        case "pause":
          v.pause();
          return { ok: true };
        case "rate":
          if (Number.isFinite(msg.rate) && msg.rate >= 0.0625 && msg.rate <= 16) {
            expectRate = msg.nudge ? msg.rate : null;
            v.playbackRate = msg.rate;
          }
          return { ok: true };
        case "vol":
          // 2.2 auto-duck: read, or set (0..1), this video's volume
          if (Number.isFinite(msg.vol) && msg.vol >= 0 && msg.vol <= 1) v.volume = msg.vol;
          return { vol: v.volume };
        case "theater":
          theater = !!msg.on;
          if (theater) theaterOn(v, { width: "100vw", height: "100vh" });
          else theaterOff();
          return { ok: true };
      }
      return null;
    })().then(
      (r) => sendResponse(r),
      () => sendResponse(null),
    );
    return true;
  });
})();
