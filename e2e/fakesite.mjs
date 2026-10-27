// Fake www.netflix.com / www.hotstar.com / www.youtube.com for extension e2e tests,
// plus a mock KLIPY API (http :8444) and a mock KLIPY media host (static.klipy.com).
// A tiny single-page app: browse/detail pages with a Play button, and watch pages
// with a player, switched with history.pushState like the real sites.
//   CSP=strict  -> the fake Netflix sends img-src 'self' blob: (KLIPY images blocked directly)
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
const video = fs.readFileSync("test.webm");
const gif = fs.readFileSync("test.gif");
const CSP = process.env.CSP || "";

const app = `<!doctype html><html><head><title>fake</title></head><body style="margin:0;background:#141414;color:#fff;font-family:sans-serif">
<div id="app"></div>
<script>
const HOT = /hotstar/.test(location.hostname);
const isWatch = () => HOT ? /\\/\\d{5,}\\/watch\\/?$/.test(location.pathname) : /^\\/watch\\/\\d+/.test(location.pathname);
const player = () => {
  const shell = HOT ? "hs-player-shell" : "watch-video", inner = HOT ? "hs-player-inner" : "watch-video--player-view";
  return '<div class="' + shell + '" style="position:fixed;inset:0;background:#000"><div class="' + inner + '" style="position:absolute;top:0;left:0;width:100%;height:100%">' +
    '<video id="v" src="/test.webm" muted autoplay style="position:absolute;top:0;left:0"></video>' +
    (HOT ? '' : '<div data-uia="video-title" style="position:absolute;top:16px;left:20px"><h4 style="margin:0">Fake Movie</h4><span>E1</span></div>') +
    '<div class="controls" style="position:absolute;left:0;right:0;bottom:0;height:64px;display:flex;justify-content:space-between;align-items:center;padding:0 20px;background:linear-gradient(transparent,#000a)">' +
    '<button id="playbtn" style="font-size:20px">play</button><span>Fake Title ' + location.pathname + '</span><button id="fsbtn" style="font-size:20px">full</button></div></div></div>';
};
const netflixBrowse = () =>
  '<div style="padding:40px"><h1>Home</h1><div class="billboard"><p>A family reunion turns into a bloodbath.</p>' +
  '<div class="billboard-links button-layer" style="display:flex;align-items:center">' +
  '<div><button data-uia="play-video-button" id="nfplay" style="height:56px;padding:0 28px;border-radius:6px;border:0;font-size:20px;font-weight:700">Play</button></div>' +
  '<div style="margin-left:12px"><button id="moreinfo" style="height:56px;padding:0 28px;border-radius:6px;border:0;font-size:20px;background:#6d6d6eb3;color:#fff">More Info</button></div>' +
  '</div></div></div>';
const hotstarDetail = () =>
  '<div id="shimmerContainer" style="padding:40px"><h1>Fake Movie</h1><div class="w-full" style="width:320px">' +
  '<button id="hswatch" style="width:320px;height:48px;border-radius:8px;border:0;font-size:18px"><span>Watch Now</span></button></div></div>';
function render() {
  const app = document.getElementById("app");
  if (isWatch()) {
    app.innerHTML = player();
    // like Netflix: the player sizes the <video> in px from its container box
    const pv = app.querySelector("[class$=player-view], .hs-player-inner"), vid = document.getElementById("v");
    new ResizeObserver(() => { const r = pv.getBoundingClientRect(); vid.style.width = r.width + "px"; vid.style.height = r.height + "px"; }).observe(pv);
    document.getElementById("fsbtn").onclick = () => document.querySelector(HOT ? ".hs-player-shell" : ".watch-video").requestFullscreen();
    // like a streaming site: router strips unknown query params
    setTimeout(() => history.replaceState(null, "", location.pathname), 50);
  } else if (HOT && /\\/in\\/movies\\//.test(location.pathname)) {
    app.innerHTML = hotstarDetail();
    // like real JioHotstar: a plain <button>, the app navigates in JS
    document.getElementById("hswatch").onclick = () => window.__go(location.pathname.replace(/\\/$/, "") + "/watch");
  }
  else if (HOT) app.innerHTML = '<div style="padding:40px"><h1>JioHotstar home</h1></div>';
  else {
    app.innerHTML = netflixBrowse();
    document.getElementById("nfplay").onclick = () => window.__go("/watch/12345");
  }
}
window.__go = (path) => { history.pushState(null, "", path); render(); };
addEventListener("popstate", render);
render();
// hotkeys eat Space/Enter like the real sites
window.__hotkeys = 0;
window.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter" || e.key === "f") { e.preventDefault(); e.stopPropagation(); window.__hotkeys++; }
}, true);
// and the player swallows clicks (like Netflix's click-to-pause layer)
window.__clicksEaten = 0;
window.addEventListener("click", (e) => { if (e.target.closest && !e.target.closest("button")) { e.preventDefault(); window.__clicksEaten++; } }, true);
</script></body></html>`;

// ---- fake YouTube: Polymer-ish custom elements, SPA navigation with yt-navigate-finish,
// player in #primary (default), #full-bleed-container (theater/fullscreen; fullscreen is on
// <ytd-app> like the real site), ads in the same <video> (class ad-showing + .video-ads),
// and a Trusted Types CSP like youtube.com.
const yt = `<!doctype html><html><head><title>YouTube</title>
<style>
ytd-app, ytd-page-manager, ytd-watch-flexy, ytd-watch-metadata { display: block; }
#masthead-container { position: fixed; top: 0; left: 0; width: 100%; height: 56px; background: #0f0f0f; z-index: 2000; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; box-sizing: border-box; }
ytd-page-manager { margin-top: 56px; }
#columns { display: flex; gap: 24px; max-width: 1754px; margin: 0 auto; padding: 24px 24px 0; box-sizing: border-box; }
#primary { flex: 1; min-width: 0; }
#secondary { width: 402px; flex: none; }
#player { width: 100%; aspect-ratio: 16 / 9; background: #000; }
#full-bleed-container { width: 100%; background: #000; }
ytd-watch-flexy:not([theater]):not([fullscreen]) #full-bleed-container { display: none; }
ytd-watch-flexy[theater] #full-bleed-container { height: min(56.25vw, calc(100vh - 169px)); }
ytd-watch-flexy[fullscreen] #full-bleed-container { height: 100vh; }
ytd-app[fullscreen] #masthead-container { display: none; }
ytd-app[fullscreen] ytd-page-manager { margin-top: 0; }
#movie_player { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }
.html5-video-container { position: absolute; inset: 0; }
.ytp-chrome-bottom { position: absolute; left: 12px; bottom: 0; height: 48px; display: flex; align-items: center; gap: 10px; }
.video-ads > div { position: absolute; left: 12px; bottom: 60px; background: #ffcc00; color: #000; padding: 4px 8px; }
#top-level-buttons-computed { display: flex; gap: 8px; }
#top-level-buttons-computed button, .ytp-chrome-bottom button { height: 36px; padding: 0 16px; border-radius: 18px; border: 0; background: #272727; color: #fff; font: 500 14px Roboto, Arial, sans-serif; }
</style></head><body style="margin:0;background:#0f0f0f;color:#fff;font-family:Roboto,Arial,sans-serif">
<ytd-app>
  <div id="masthead-container"><b>YouTube</b><span id="mh-right">Sign in</span></div>
  <div id="content"><ytd-page-manager id="page-manager"></ytd-page-manager></div>
</ytd-app>
<script nonce="ytfake">
const tt = trustedTypes.createPolicy("fake", { createHTML: (s) => s });
const VIDS = { aaaaaaaaaaa: "Fake Trailer One", bbbbbbbbbbb: "Fake Video Two" };
let mp = null, savedPos = 0;
function watch(id) {
  const pm = document.getElementById("page-manager");
  pm.innerHTML = tt.createHTML('<ytd-watch-flexy><div id="full-bleed-container"></div><div id="columns"><div id="primary"><div id="player"></div>' +
    '<ytd-watch-metadata><div id="title"><h1>' + VIDS[id] + '</h1></div><div id="actions"><div id="actions-inner"><ytd-menu-renderer><div id="top-level-buttons-computed">' +
    '<button id="likebtn">Like</button><button>Share</button></div></ytd-menu-renderer></div></div></ytd-watch-metadata>' +
    '<p><a id="next" href="/watch?v=' + (id === "aaaaaaaaaaa" ? "bbbbbbbbbbb" : "aaaaaaaaaaa") + '">Next video</a></p></div>' +
    '<div id="secondary"><p>Recommended</p></div></div></ytd-watch-flexy>');
  if (!mp) {
    mp = document.createElement("div");
    mp.id = "movie_player";
    mp.className = "html5-video-player";
    mp.innerHTML = tt.createHTML('<div class="html5-video-container"><video class="video-stream html5-main-video" src="/test.webm" muted autoplay style="position:absolute"></video></div>' +
      '<div class="video-ads ytp-ad-module"></div><div class="ytp-chrome-bottom"><button id="theaterbtn">theater</button><button id="fsbtn">full</button></div>');
    // like YouTube's player: the <video> is sized in px to fit #movie_player (16:9, letterboxed)
    const v = mp.querySelector("video");
    new ResizeObserver(() => {
      const r = mp.getBoundingClientRect();
      const w = Math.min(r.width, r.height * 16 / 9), h = w * 9 / 16;
      Object.assign(v.style, { width: w + "px", height: h + "px", left: (r.width - w) / 2 + "px", top: (r.height - h) / 2 + "px" });
    }).observe(mp);
    mp.querySelector("#theaterbtn").onclick = () => window.__theater(!document.querySelector("ytd-watch-flexy").hasAttribute("theater"));
    mp.querySelector("#fsbtn").onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.querySelector("ytd-app").requestFullscreen();
  }
  place();
  document.getElementById("next").onclick = (e) => { e.preventDefault(); window.__go("/watch?v=" + e.target.href.split("v=")[1]); };
}
function place() {
  const f = document.querySelector("ytd-watch-flexy");
  if (!f) return;
  const big = f.hasAttribute("theater") || f.hasAttribute("fullscreen");
  (big ? f.querySelector("#full-bleed-container") : f.querySelector("#player")).append(mp);
}
window.__theater = (on) => { document.querySelector("ytd-watch-flexy").toggleAttribute("theater", on); place(); };
document.addEventListener("fullscreenchange", () => {
  const on = !!document.fullscreenElement;
  document.querySelector("ytd-app").toggleAttribute("fullscreen", on);
  document.querySelector("ytd-watch-flexy")?.toggleAttribute("fullscreen", on);
  place();
});
window.__ad = (on) => {
  const v = mp.querySelector("video"), ads = mp.querySelector(".video-ads");
  if (on) { savedPos = v.currentTime; mp.classList.add("ad-showing", "ad-interrupting"); ads.innerHTML = tt.createHTML("<div>Ad · 0:15</div>"); v.currentTime = 100; v.play(); }
  else { mp.classList.remove("ad-showing", "ad-interrupting"); ads.textContent = ""; v.currentTime = savedPos; v.play(); }
};
function render() {
  const v = new URLSearchParams(location.search).get("v");
  if (location.pathname === "/watch" && VIDS[v]) { watch(v); document.title = VIDS[v] + " - YouTube"; }
  else { document.getElementById("page-manager").innerHTML = tt.createHTML('<div style="padding:40px"><h1>Home</h1><a id="open1" href="/watch?v=aaaaaaaaaaa">Fake Trailer One</a></div>'); document.title = "YouTube"; mp?.querySelector("video").pause(); }
  document.dispatchEvent(new CustomEvent("yt-navigate-finish"));
}
window.__go = (path) => { history.pushState(null, "", path); render(); };
addEventListener("popstate", render);
render();
// YouTube's hotkeys (k = pause, j/l = seek, f = fullscreen, space)
window.__hotkeys = 0;
document.addEventListener("keydown", (e) => {
  if ([" ", "k", "j", "l", "f", "m", "Enter"].includes(e.key)) { e.preventDefault(); window.__hotkeys++; }
});
</script></body></html>`;

// mock KLIPY media (static.klipy.com is mapped here by the browser's host-resolver-rules)
https.createServer({ key: fs.readFileSync("key.pem"), cert: fs.readFileSync("cert.pem") }, (req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  if (/klipy\.com$/.test(host)) {
    if (/^\/test\/.+\.gif/.test(req.url)) {
      res.writeHead(200, { "content-type": "image/gif", "content-length": gif.length, "access-control-allow-origin": "*" });
      return res.end(gif);
    }
    res.writeHead(404);
    return res.end();
  }
  if (req.url.startsWith("/test.webm")) {
    const range = req.headers.range;
    if (range) {
      const [s, e] = range.replace("bytes=", "").split("-");
      const start = +s, end = e ? +e : video.length - 1;
      res.writeHead(206, { "content-type": "video/webm", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${video.length}`, "content-length": end - start + 1 });
      return res.end(video.subarray(start, end + 1));
    }
    res.writeHead(200, { "content-type": "video/webm", "accept-ranges": "bytes", "content-length": video.length });
    return res.end(video);
  }
  if (host === "www.youtube.com") {
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": "require-trusted-types-for 'script'; trusted-types fake; script-src 'nonce-ytfake' 'strict-dynamic'" });
    return res.end(yt);
  }
  const headers = { "content-type": "text/html" };
  if (CSP === "strict" && host === "www.netflix.com") headers["content-security-policy"] = "img-src 'self' blob:";
  res.writeHead(200, headers);
  res.end(app);
}).listen(8443, () => console.log("fake site on 8443" + (CSP ? " (CSP " + CSP + ")" : "")));

// mock KLIPY API (Tenor-compatible v2 shape); /__last shows the last search
let last = null;
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/__last") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(last));
  }
  if (u.pathname === "/v2/search" || u.pathname === "/v2/featured") {
    last = { path: u.pathname, q: u.searchParams.get("q"), key: u.searchParams.get("key"), pos: u.searchParams.get("pos") };
    const page = Number(u.searchParams.get("pos") || 0);
    const results = Array.from({ length: 8 }, (_, i) => {
      const id = `${page * 8 + i}`;
      return { id, title: "fake gif " + id, media_formats: { tinygif: { url: `https://static.klipy.com/test/${id}.gif`, dims: [200, 150] }, nanogif: { url: `https://static.klipy.com/test/${id}n.gif`, dims: [120, 90] } } };
    });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ results, next: page < 2 ? String(page + 1) : "" }));
  }
  res.writeHead(404);
  res.end();
}).listen(8444, () => console.log("mock KLIPY on 8444"));
