import path from "node:path";
import { MEDIA_DIR } from "./config.mjs";
// Fake www.netflix.com / www.hotstar.com / www.youtube.com / www.primevideo.com (+ www.amazon.co.uk/gp/video) for extension e2e tests,
// plus a mock KLIPY API (http :8444) and a mock KLIPY media host (static.klipy.com).
// A tiny single-page app: browse/detail pages with a Play button, and watch pages
// with a player, switched with history.pushState like the real sites.
//   CSP=strict  -> the fake Netflix sends img-src 'self' blob: (KLIPY images blocked directly)
//   cookie or query npimg=none / npimg=data -> that browser's (page's) fake Netflix sends img-src 'self' / img-src 'self' data:
//   CSP=script  -> also script-src 'self' 'unsafe-inline' on Netflix/JioHotstar (extension <script src> injection)
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
const video = fs.readFileSync(path.join(MEDIA_DIR, "test.webm"));
const gif = fs.readFileSync(path.join(MEDIA_DIR, "test.gif"));
const CSP = process.env.CSP || "";

const app = `<!doctype html><html><head><title>fake</title></head><body style="margin:0;background:#141414;color:#fff;font-family:sans-serif">
<div id="app"></div>
<script>
const HOT = /hotstar/.test(location.hostname);
const isWatch = () => HOT ? /\\/\\d{5,}\\/watch\\/?$/.test(location.pathname) : /^\\/watch\\/\\d+/.test(location.pathname);
const player = () => {
  const shell = HOT ? "hs-player-shell" : "watch-video", inner = HOT ? "hs-player-inner" : "watch-video--player-view";
  return '<div class="' + shell + '" style="position:fixed;inset:0;background:#000"><div class="' + inner + '" style="position:absolute;top:0;left:0;width:100%;height:100%">' +
    '<video id="v" src="' + (localStorage.fakeGate ? "/gate.webm?g=" + encodeURIComponent(localStorage.fakeGate) + "&r=" + Math.random() : "/test.webm") + '" muted autoplay style="position:absolute;top:0;left:0"></video>' +
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
/*LIVEPLAYER*/
const VIDS = { aaaaaaaaaaa: "Fake Trailer One", bbbbbbbbbbb: "Fake Video Two", LIVEstream1: "Fake Live Stream" };
const LIVE = { LIVEstream1: true };
let mp = null, savedPos = 0;
function watch(id) {
  const pm = document.getElementById("page-manager");
  pm.innerHTML = tt.createHTML('<ytd-watch-flexy video-id="' + id + '"><div id="full-bleed-container"></div><div id="columns"><div id="primary"><div id="player"></div>' +
    '<ytd-watch-metadata><div id="title"><h1>' + VIDS[id] + '</h1></div><div id="actions"><div id="actions-inner"><ytd-menu-renderer><div id="top-level-buttons-computed">' +
    '<button id="likebtn">Like</button><button>Share</button></div></ytd-menu-renderer></div></div></ytd-watch-metadata>' +
    '<p><a id="next" href="/watch?v=' + (id === "aaaaaaaaaaa" ? "bbbbbbbbbbb" : "aaaaaaaaaaa") + '">Next video</a></p></div>' +
    '<div id="secondary"><p>Recommended</p></div></div></ytd-watch-flexy>');
  if (!mp) {
    mp = document.createElement("div");
    mp.id = "movie_player";
    mp.className = "html5-video-player";
    mp.innerHTML = tt.createHTML('<div class="html5-video-container"><video class="video-stream html5-main-video" src="/test.webm" muted autoplay style="position:absolute"></video></div>' +
      '<div class="video-ads ytp-ad-module"></div><div class="ytp-progress-bar" role="slider" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" style="position:absolute;left:0;right:0;bottom:48px;height:4px;background:#f00"></div>' +
      '<div class="ytp-chrome-bottom"><button id="theaterbtn">theater</button><button id="fsbtn">full</button><button class="ytp-live-badge ytp-button" style="display:none">Live</button><div class="ytp-time-display"></div></div>');
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
  // a live stream plays through Media Source Extensions with a rewind window (see livePlayer); its LIVE badge shows
  const v = mp.querySelector("video");
  mp.querySelector(".ytp-live-badge").style.display = LIVE[id] ? "" : "none";
  mp.querySelector(".ytp-time-display").classList.toggle("ytp-live", !!LIVE[id]);
  if (LIVE[id]) { if (mp.dataset.live !== id) { mp.dataset.live = id; window.__livePlayer(v, { dvr: true, bar: mp.querySelector(".ytp-progress-bar") }); } }
  else if (mp.dataset.live) { delete mp.dataset.live; v.src = "/test.webm"; v.play().catch(() => {}); }
  else {
    // an ordinary video: the bar runs over the video's length
    clearInterval(window.__barT);
    window.__barT = setInterval(() => { const b = mp.querySelector(".ytp-progress-bar"); if (mp.dataset.live) return; b.setAttribute("aria-valuemax", String(Math.floor(v.duration || 0))); b.setAttribute("aria-valuenow", String(Math.floor(v.currentTime))); }, 250);
  }
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
  // live streams' own addresses: /live/<id>, and a channel's /@name/live
  const lv = (location.pathname.match(/^\\/live\\/([\\w-]{11})$/) || [])[1] || (location.pathname === "/@fakechannel/live" ? "LIVEstream1" : null);
  if (lv && VIDS[lv]) { watch(lv); document.title = VIDS[lv] + " - YouTube"; }
  else if (location.pathname === "/watch" && VIDS[v]) { watch(v); document.title = VIDS[v] + " - YouTube"; }
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

// ---- fake Prime Video (www.primevideo.com and www.amazon.co.uk/gp/video): title pages with a Play
// button and a muted hero trailer; the player is an overlay (#dv-web-player, position:fixed) on the
// same page that gets its <video> when it opens (?autoplay=1 opens it on load), like the real site.
// An SPA: other titles via pushState. __pvAd(on) shows the player's ad countdown; __pvClose() closes it.
const pv = `<!doctype html><html><head><title>Prime Video</title>
<style>
body { margin: 0; background: #0f171e; color: #fff; font-family: Arial, sans-serif; }
#dv-web-player { display: none; }
#dv-web-player.dv-player-fullscreen { display: block; position: fixed; inset: 0; z-index: 1000; background: #000; }
.webPlayerSDKContainer { position: absolute; inset: 0; }
.rendererContainer { position: absolute; inset: 0; }
.atvwebplayersdk-overlays-container { position: absolute; left: 0; right: 0; top: 0; height: 60px; display: flex; align-items: center; gap: 12px; padding: 0 20px; }
.atvwebplayersdk-ad-timer-text { position: absolute; right: 20px; top: 70px; background: #ff0; color: #000; padding: 2px 8px; }
.pv-controls { position: absolute; left: 0; right: 0; bottom: 0; height: 64px; display: flex; align-items: center; gap: 12px; padding: 0 20px; background: linear-gradient(transparent, #000a); }
.dv-hero video { width: 320px; height: 180px; }
</style></head><body>
<div id="pv-app"></div>
<div id="dv-web-player"></div>
<script>
const AMZ = /amazon\\./.test(location.hostname);
const TITLES = { "0PVFAKEMOVIE1": "Fake Prime Movie", "0PVFAKEMOVIE2": "Fake Prime Two", B0FAKEUK01: "Fake UK Movie" };
const titleId = () => (location.pathname.match(AMZ ? /\\/gp\\/video\\/detail\\/([A-Za-z0-9._-]+)/ : /\\/detail\\/([A-Za-z0-9._-]+)/) || [])[1];
function closePlayer() {
  const p = document.getElementById("dv-web-player");
  p.classList.remove("dv-player-fullscreen");
  p.textContent = "";
}
function openPlayer() {
  const id = titleId(), p = document.getElementById("dv-web-player");
  if (!TITLES[id] || p.classList.contains("dv-player-fullscreen")) return;
  p.classList.add("dv-player-fullscreen");
  p.innerHTML = '<div class="webPlayerSDKContainer"><div class="rendererContainer"><video id="v" src="/test.webm" muted autoplay style="position:absolute;top:0;left:0"></video></div>' +
    '<div class="atvwebplayersdk-overlays-container"><button id="pvback">back</button><h1 class="atvwebplayersdk-title-text" style="font-size:18px;margin:0">' + TITLES[id] + '</h1></div>' +
    '<div class="pv-controls"><button id="pvplay">play</button><button id="pvfs">full</button></div></div>';
  const box = p.querySelector(".webPlayerSDKContainer"), vid = p.querySelector("video");
  new ResizeObserver(() => { const r = box.getBoundingClientRect(); vid.style.width = r.width + "px"; vid.style.height = r.height + "px"; }).observe(box);
  p.querySelector("#pvback").onclick = closePlayer;
  p.querySelector("#pvplay").onclick = () => (vid.paused ? vid.play() : vid.pause());
  p.querySelector("#pvfs").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : p.requestFullscreen());
}
window.__pvClose = closePlayer;
window.__pvAd = (on) => {
  const p = document.querySelector("#dv-web-player .webPlayerSDKContainer");
  let n = p.querySelector(".atvwebplayersdk-ad-timer-text");
  if (on && !n) { n = document.createElement("div"); n.className = "atvwebplayersdk-ad-timer-text"; n.textContent = "Ad 0:15"; p.append(n); p.querySelector("video").currentTime = 100; }
  if (!on && n) n.remove();
};
function render() {
  const id = titleId(), app = document.getElementById("pv-app");
  closePlayer();
  if (!TITLES[id]) { app.innerHTML = '<div style="padding:40px"><h1>Prime Video home</h1><a id="pvopen" href="' + (AMZ ? "/gp/video/detail/B0FAKEUK01" : "/detail/0PVFAKEMOVIE1/ref=atv_hm") + '">Open</a></div>'; return; }
  document.title = "Prime Video: " + TITLES[id];
  app.innerHTML = '<div style="padding:40px"><div class="dv-hero"><video class="hero-trailer" src="/test.webm" muted autoplay loop></video></div><h1 data-automation-id="title">' + TITLES[id] + '</h1>' +
    '<div class="dv-dp-node-playback" style="display:flex;gap:12px;align-items:center">' +
    '<a href="?autoplay=1&ref_=atv_dp_pb" data-testid="play-button" id="pvplaylink" style="display:inline-flex"><button id="pvplaybtn" aria-label="Play" style="height:48px;padding:0 24px;border-radius:8px;border:0;font-size:18px;font-weight:700">Play</button></a>' +
    '<button id="pvtrailer" style="height:48px;padding:0 24px;border-radius:8px;border:0;font-size:18px">Trailer</button>' +
    '<button style="height:48px;padding:0 24px;border-radius:8px;border:0;font-size:18px">Watchlist</button></div>' +
    '<p><a id="pvnext" href="' + (AMZ ? "/gp/video/detail/B0FAKEUK01" : "/detail/0PVFAKEMOVIE2") + '">Another title</a></p></div>';
  // like Prime: the play link opens the overlay player without leaving the page
  app.querySelector("#pvplaylink").onclick = (e) => { e.preventDefault(); history.replaceState(null, "", location.pathname + "?autoplay=1"); openPlayer(); };
  app.querySelector("#pvnext").onclick = (e) => { e.preventDefault(); window.__go(e.currentTarget.getAttribute("href")); };
}
window.__go = (path) => { history.pushState(null, "", path); render(); };
addEventListener("popstate", render);
render();
const q = new URLSearchParams(location.search);
// the router drops unknown parameters, then autoplay opens the player a moment later
setTimeout(() => history.replaceState(null, "", location.pathname + (q.get("autoplay") === "1" ? "?autoplay=1" : "")), 50);
if (q.get("autoplay") === "1") setTimeout(openPlayer, 900);
window.__hotkeys = 0;
window.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter" || e.key === "f") { e.preventDefault(); e.stopPropagation(); window.__hotkeys++; }
}, true);
</script></body></html>`;

// ---- 2.2 fixtures: HBO Max, Crunchyroll, SonyLIV. Shapes from the services' public pages (URL formats, the
// Crunchyroll "vilos" player iframe on static.crunchyroll.com, SonyLIV's ?watch=true player with an IMA ad layer,
// HBO Max's /video/watch/<uuid>/<uuid> player). No code from the services; we can't sign in to them.
const HBO_IDS = { "1f4b4570-933c-4264-b6e4-4aa9f596a9f5/a4f1e82b-a9f0-4e73-a692-35b31b9e0608": "Fake HBO Episode 1", "53efe792-9bd3-4e0c-b80e-87396b7ddcaf/d98913ef-a05c-46e7-84b1-e57e7b5e8727": "Fake HBO Episode 2" };
const hbo = `<!doctype html><html><head><title>HBO Max</title><style>body{margin:0;background:#000;color:#fff;font-family:sans-serif}
[data-testid=playerContainer]{position:fixed;inset:0;background:#000}[data-testid=playerContainer] video{width:100%;height:100%}
[data-testid=player-ux-asset-title]{position:absolute;top:16px;left:20px;margin:0;font-size:18px}
[data-testid=ad-badge]{position:absolute;top:60px;left:20px;background:#ff0;color:#000;padding:2px 8px}</style></head><body><div id="app"></div><script>
const IDS = ${JSON.stringify(HBO_IDS)};
function render() {
  const m = location.pathname.match(/^\\/video\\/watch\\/(.+?)\\/?$/), app = document.getElementById("app");
  if (m && IDS[m[1]]) {
    document.title = IDS[m[1]] + " • HBO Max";
    app.innerHTML = '<div data-testid="playerContainer"><video src="/test.webm" muted autoplay></video><h1 data-testid="player-ux-asset-title">' + IDS[m[1]] + '</h1><button id="hbonext" style="position:absolute;bottom:20px;right:20px">Next episode</button></div>';
    document.getElementById("hbonext").onclick = () => window.__go("/video/watch/" + Object.keys(IDS).find((k) => k !== m[1]));
  } else { document.title = "HBO Max"; app.innerHTML = '<div style="padding:40px"><h1>HBO Max home</h1><a id="hboopen" href="/video/watch/' + Object.keys(IDS)[0] + '">Open</a></div>'; }
}
window.__go = (p) => { history.pushState(null, "", p); render(); };
window.__hboAd = (on) => { const c = document.querySelector("[data-testid=playerContainer]"); let n = c.querySelector("[data-testid=ad-badge]"); if (on && !n) { n = document.createElement("div"); n.dataset.testid = "ad-badge"; n.textContent = "Ad 1 of 2 · 0:15"; c.append(n); c.querySelector("video").currentTime = 100; } if (!on && n) n.remove(); };
addEventListener("popstate", render);
render();
setTimeout(() => history.replaceState(null, "", location.pathname), 50); // the router drops unknown parameters
window.__hotkeys = 0;
window.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter" || e.key === "f") { e.preventDefault(); e.stopPropagation(); window.__hotkeys++; } }, true);
</script></body></html>`;
const CR_EPS = { GY0973WVY: "The Talisman Woman", G4PH0WXVJ: "Fake Crunchy Episode 2" };
const cr = `<!doctype html><html><head><title>Crunchyroll</title><meta property="og:title" content="Watch Fake Anime - Crunchyroll"><style>body{margin:0;background:#000;color:#fff;font-family:sans-serif}
.video-player-wrapper{position:relative;width:100%;aspect-ratio:16/9;max-height:80vh;background:#000}.video-player{position:absolute;inset:0;width:100%;height:100%;border:0}
.erc-current-media-info{padding:12px 20px}</style></head><body><div id="app"></div><script>
const EPS = ${JSON.stringify(CR_EPS)};
function render() {
  const m = location.pathname.match(/^(?:\\/[a-z]{2}(?:-[a-z]{2,4})?)?\\/watch\\/([A-Z0-9]+)/), app = document.getElementById("app");
  if (m && EPS[m[1]]) {
    app.innerHTML = '<div class="video-player-wrapper"><iframe class="video-player" src="https://static.crunchyroll.com/vilos-v2/web/vilos/player.html" allow="autoplay; fullscreen; encrypted-media" allowfullscreen></iframe></div>' +
      '<div class="erc-current-media-info"><h1 class="title">' + EPS[m[1]] + '</h1><a id="crnext" href="/watch/' + Object.keys(EPS).find((k) => k !== m[1]) + '/next">Next episode</a></div>';
    document.getElementById("crnext").onclick = (e) => { e.preventDefault(); window.__go(e.currentTarget.getAttribute("href")); };
  } else app.innerHTML = '<div style="padding:40px"><h1>Crunchyroll home</h1></div>';
}
window.__go = (p) => { history.pushState(null, "", p); render(); };
addEventListener("popstate", render);
render();
setTimeout(() => history.replaceState(null, "", location.pathname), 50);
window.__hotkeys = 0;
window.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter" || e.key === "f") { e.preventDefault(); e.stopPropagation(); window.__hotkeys++; } }, true);
</script></body></html>`;
// the player frame (static.crunchyroll.com/vilos-v2/web/vilos/player.html): its own <video>; __crAd(on) shows the ad label
const vilos = `<!doctype html><html><head><title>Vilos</title><style>html,body{margin:0;height:100%;background:#000;display:flex}#vilosRoot{position:relative;flex:1}video{width:100%;height:100%}
.ad-indicator{position:absolute;top:10px;left:10px;background:#f47521;color:#000;padding:2px 8px}</style></head><body><div id="vilosRoot"><video id="player0" src="https://static.crunchyroll.com/test.webm" muted autoplay></video></div><script>
window.__crAd = (on) => { const r = document.getElementById("vilosRoot"); let n = r.querySelector(".ad-indicator"); if (on && !n) { n = document.createElement("div"); n.className = "ad-indicator"; n.dataset.testid = "vilos-ad-indicator"; n.textContent = "Ad 1/2"; r.append(n); r.querySelector("video").currentTime = 100; } if (!on && n) n.remove(); };
</script></body></html>`;
const SL_TITLES = { "1000022678": "Achaari Cheese Toast", "1000050121": "Tahalka", "1000022679": "Fake Sony Episode 2" };
const sl = `<!doctype html><html><head><title>SonyLIV</title><style>body{margin:0;background:#111;color:#fff;font-family:sans-serif}
.playerContainer{position:fixed;inset:0;background:#000}.playerContainer video{width:100%;height:100%}.playerTitle{position:absolute;top:16px;left:20px;margin:0}
.ima-ad-container{position:absolute;inset:0;display:none}.ima-ad-container.on{display:block}.ima-ad-container .ad-label{position:absolute;bottom:70px;left:20px;background:#ff0;color:#000;padding:2px 8px}
.hero video{width:320px;height:180px}</style></head><body><div id="app"></div><script>
const T = ${JSON.stringify(SL_TITLES)};
function render() {
  const id = (location.pathname.match(/-(\\d+)\\/?$/) || [])[1], app = document.getElementById("app");
  if (!T[id]) { document.title = "SonyLIV"; app.innerHTML = '<div style="padding:40px"><h1>SonyLIV home</h1></div>'; return; }
  document.title = "Watch " + T[id] + " Full HD Movie Online - Sony LIV";
  if (new URLSearchParams(location.search).get("watch") === "true") {
    app.innerHTML = '<div class="playerContainer"><video src="/test.webm" muted autoplay></video><h2 class="playerTitle">' + T[id] + '</h2><div class="ima-ad-container"></div><button id="slnext" style="position:absolute;bottom:20px;right:20px">Next</button></div>';
    document.getElementById("slnext").onclick = () => window.__go("/shows/bachelors-delight-1700000113/fake-sony-episode-2-1000022679?watch=true");
  } else {
    app.innerHTML = '<div style="padding:40px"><div class="hero"><video src="/test.webm" muted autoplay loop></video></div><h1>' + T[id] + '</h1><button id="slwatch" style="height:44px;padding:0 24px">Watch Now</button></div>';
    document.getElementById("slwatch").onclick = () => window.__go(location.pathname + "?watch=true");
  }
}
window.__go = (p) => { history.pushState(null, "", p); render(); };
window.__slAd = (on) => { const a = document.querySelector(".ima-ad-container"); a.classList.toggle("on", on); a.innerHTML = on ? '<div class="ad-label">Ad · 0:10</div>' : ""; if (on) document.querySelector(".playerContainer video").currentTime = 100; };
addEventListener("popstate", render);
render();
const q = new URLSearchParams(location.search);
setTimeout(() => history.replaceState(null, "", location.pathname + (q.get("watch") === "true" ? "?watch=true" : "")), 50);
window.__hotkeys = 0;
window.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter" || e.key === "f") { e.preventDefault(); e.stopPropagation(); window.__hotkeys++; } }, true);
</script></body></html>`;

// ---- 2.4 fixtures: Hulu, Disney+, Paramount+, STARZ, Tubi. Built from the services' public URL shapes (we can't
// sign in to them). Disney+ keeps its <video> in a player element's open shadow root; Paramount+ shows its ad
// as a plain "Ad 1 of 3 · 0:15" label; Tubi's title page is also its player (Play, or ?start=true). Each has a
// home page, a player with the title, a "next" button (single-page navigation) and __ad(on) for an ad break.
const S24 = {
  "www.hulu.com": {
    name: "Hulu", watch: "^\\/watch\\/([0-9a-f-]{36})\\/?$", ids: { "5f1e6a2c-3b4d-4e5f-8a9b-0c1d2e3f4a5b": "Fake Hulu Episode 1", "7a2b3c4d-5e6f-4a1b-9c8d-7e6f5a4b3c2d": "Fake Hulu Episode 2" },
    path: (id) => "/watch/" + id, title: (t) => "Watch " + t + " Online | Hulu", ad: '<div class="AdBadge">Ad · 0:15</div>',
  },
  "www.disneyplus.com": {
    name: "Disney+", watch: "^(?:\\/[a-z]{2}(?:-[a-z]{2,4})?)?\\/play\\/([0-9a-f-]{36})\\/?$", ids: { "e9fe54b5-9eb8-4298-8d72-f125d5b1aad1": "Fake Disney Movie", "0b7c6d5e-4f3a-4b2c-8d1e-9f8a7b6c5d4e": "Fake Disney Episode 2" },
    path: (id) => "/play/" + id, title: (t) => "Watch " + t + " | Disney+", shadow: true, ad: '<div class="ad-badge">Ad 1 of 2</div>',
  },
  "www.paramountplus.com": {
    name: "Paramount+", watch: "^\\/(?:shows|movies)\\/video\\/([A-Za-z0-9_-]{8,64})\\/?$", ids: { ALVE01M5AWA8K9EZZB3A56AC0VQQK1: "Fake Paramount Episode 1", ALVE01M6P7EPS2E41SBYNNGPQJC6A7: "Fake Paramount Episode 2" },
    path: (id) => "/shows/video/" + id + "/", title: (t) => "Watch " + t + " - Paramount+", ad: "<span>Ad 1 of 3 · 0:15</span>",
  },
  "www.starz.com": {
    name: "STARZ", watch: "^\\/us\\/en\\/play\\/(\\d+)\\/?$", ids: { 62917: "Fake Starz Episode 1", 62918: "Fake Starz Episode 2" },
    path: (id) => "/us/en/play/" + id, title: (t) => t + " | STARZ",
  },
  "tubitv.com": {
    name: "Tubi", watch: "^\\/(?:movies|tv-shows)\\/(\\d+)(?:\\/[a-z0-9-]+)?\\/?$", ids: { 605225: "Jack and Jill", 605226: "Fake Tubi Movie 2" },
    path: (id) => "/movies/" + id + "/" + (id === "605225" ? "jack-and-jill" : "fake-tubi-movie-2"), title: (t) => "Watch " + t + " (2011) - Free Movies | Tubi", detail: true,
    ad: '<div data-test-id="ad-countdown">Ad 0:10</div>',
  },
};
const site24 = (host) => {
  const S = S24[host];
  return `<!doctype html><html><head><title>${S.name}</title><style>body{margin:0;background:#0b0c0f;color:#fff;font-family:sans-serif}
.player{position:fixed;inset:0;background:#000}.player video{width:100%;height:100%}.ttl{position:absolute;top:16px;left:20px;margin:0;font-size:18px}
.adl{position:absolute;top:60px;left:20px;background:#ff0;color:#000;padding:2px 8px}</style></head><body><div id="app"></div><script>
const S = ${JSON.stringify({ ...S, path: undefined, title: undefined })}, W = new RegExp(S.watch);
const PATH = ${S.path.toString()}, TITLE = ${S.title.toString()};
const vid = () => S.shadow ? document.querySelector("fake-web-player")?.shadowRoot.querySelector("video") : document.querySelector(".player video");
function render() {
  const m = location.pathname.match(W), app = document.getElementById("app"), t = m && S.ids[m[1]];
  if (!t) { document.title = S.name; app.innerHTML = '<div style="padding:40px"><h1>' + S.name + ' home</h1></div>'; return; }
  document.title = TITLE(t);
  if (S.detail && !window.__started && new URLSearchParams(location.search).get("start") !== "true") {
    app.innerHTML = '<div style="padding:40px"><h1>' + t + '</h1><button id="tbplay" style="height:44px;padding:0 24px">Play</button></div>';
    document.getElementById("tbplay").onclick = () => { window.__started = true; render(); };
    return;
  }
  const next = Object.keys(S.ids).find((k) => k !== m[1]);
  const inner = '<video src="/test.webm" muted autoplay></video><h1 class="ttl">' + t + '</h1>';
  if (S.shadow) {
    app.innerHTML = '<div class="player"><fake-web-player style="display:block;width:100%;height:100%"></fake-web-player><button id="next24" style="position:absolute;bottom:20px;right:20px">Next</button></div>';
    const root = app.querySelector("fake-web-player").attachShadow({ mode: "open" });
    root.innerHTML = '<style>video{width:100%;height:100%;display:block}.ad-badge{position:absolute;top:60px;left:20px;background:#ff0;color:#000;padding:2px 8px}</style>' + inner;
  } else app.innerHTML = '<div class="player">' + inner + '<button id="next24" style="position:absolute;bottom:20px;right:20px">Next</button></div>';
  document.getElementById("next24").onclick = () => { window.__started = true; window.__go(PATH(next)); };
}
window.__go = (p) => { history.pushState(null, "", p); render(); };
window.__ad = (on) => {
  const box = S.shadow ? document.querySelector("fake-web-player").shadowRoot : document.querySelector(".player");
  let n = box.querySelector("#ad24");
  if (on && !n && S.ad) { const d = document.createElement("div"); d.id = "ad24"; d.innerHTML = S.ad; d.firstChild.classList.add("adl"); box.append(d); vid().currentTime = 100; }
  if (!on && n) n.remove();
};
addEventListener("popstate", render);
render();
setTimeout(() => history.replaceState(null, "", location.pathname), 50); // the router drops unknown parameters
window.__hotkeys = 0;
window.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter" || e.key === "f") { e.preventDefault(); e.stopPropagation(); window.__hotkeys++; } }, true);
</script></body></html>`;
};

// ---- 2.5 live streams. One fake broadcast for every page: livesim/seg-<n>.webm (2 s WebM segments, made with
// ffmpeg, see e2e/README.md) where segment n becomes available n * 2 s after this server started, like a live
// playlist. A page plays it through Media Source Extensions starting near the newest segment, so each viewer's
// player has its own buffer and delay behind live, exactly what NetParty has to line up. The stream's own time is
// the same for everyone, so the tests can check true sync by comparing currentTime.
// Per browser (cookies): npl_behind=<s> how far behind the newest segment the player starts (default 3),
// npl_dvr=1 keeps 90 s of the stream behind (a rewind window; otherwise the player drops what's over 8 s behind),
// npl_snap=1 jumps back to near the live edge whenever it resumes (some players do that), npl_keep=<s> how much of
// the stream a player without a rewind window keeps behind where it plays (default 8).
const LIVE_T0 = Date.now();
const LIVE_DIR = path.join(MEDIA_DIR, "livesim");
const livePlayer = `window.__livePlayer = async function (v, o) {
  o = o || {};
  const ck = (k) => (document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)")) || [])[1];
  const behind = ck("npl_behind") != null ? +ck("npl_behind") : (o.behind ?? 3), dvr = ck("npl_dvr") === "1" || !!o.dvr, snap = ck("npl_snap") === "1";
  const keep = ck("npl_keep") != null ? +ck("npl_keep") : 8;
  const ms = new MediaSource();
  v.removeAttribute("src");
  v.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
  ms.duration = Infinity;
  const sb = ms.addSourceBuffer('video/webm; codecs="vp8"');
  const op = (f) => new Promise((res, rej) => { sb.addEventListener("updateend", res, { once: true }); sb.addEventListener("error", rej, { once: true }); f(); });
  const clk = await (await fetch("/livesim/clock")).json();
  const off = clk.now - Date.now();
  const latest = () => Math.floor((Date.now() + off - clk.t0) / 2000);
  await op(async () => sb.appendBuffer(await (await fetch("/livesim/init.webm")).arrayBuffer()));
  let next = Math.max(1, latest() - (dvr ? 45 : 4) + 1), started = false, busy = false;
  window.__liveInfo = () => ({ t: v.currentTime, edge: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : null, start: v.buffered.length ? v.buffered.start(0) : null, paused: v.paused });
  async function pump() {
    if (busy || v.src.indexOf("blob:") !== 0) return;
    busy = true;
    try {
      while (next <= latest()) {
        const r = await fetch("/livesim/seg-" + next + ".webm");
        if (!r.ok) break;
        const buf = await r.arrayBuffer();
        await op(() => sb.appendBuffer(buf));
        next++;
      }
      if (!started && v.buffered.length) {
        started = true;
        v.currentTime = Math.max(v.buffered.start(0), v.buffered.end(v.buffered.length - 1) - behind);
        v.play().catch(() => {});
      }
      if (!dvr && v.buffered.length && v.currentTime - v.buffered.start(0) > keep + 4) await op(() => sb.remove(0, v.currentTime - keep));
    } catch (e) { console.log("livesim: " + e.message); } finally { busy = false; }
  }
  setInterval(pump, 400);
  pump();
  if (snap) v.addEventListener("play", () => { const e = v.buffered.length && v.buffered.end(v.buffered.length - 1); if (e && e - v.currentTime > 3) v.currentTime = e - 1.5; });
  if (o.bar) setInterval(() => {
    if (!v.buffered.length) return;
    o.bar.setAttribute("aria-valuemin", String(Math.floor(v.buffered.start(0))));
    o.bar.setAttribute("aria-valuemax", String(Math.floor(v.buffered.end(v.buffered.length - 1))));
    o.bar.setAttribute("aria-valuenow", String(Math.floor(v.currentTime)));
  }, 250);
};`;
// Twitch (www.twitch.tv/<channel>: the player in [data-a-target=video-player], side nav, chat column), Kick
// (kick.com/<channel>: <video-player>), Rumble (rumble.com/<id>-<slug>.html: a live show with a rewind window, and an
// ordinary video). Each has __ad(on) (an ad label over the player) and a link to another stream.
const LIVE_SITES = {
  "www.twitch.tv": { name: "Twitch", chans: { fakestreamer: "Fake Twitch Stream", otherchan: "Another Fake Stream" }, path: (c) => "/" + c,
    player: (inner) => '<div style="display:flex"><nav style="width:240px;flex:none">side nav<div class="side-nav-card"><video src="/test.webm" muted autoplay loop style="width:60px;height:34px"></video></div></nav><main style="flex:1"><div data-a-target="video-player" class="video-player" style="position:relative;width:100%;aspect-ratio:16/9;background:#000">' + inner + '</div><h2 data-a-target="stream-title">TITLE</h2></main><aside style="width:340px;flex:none">chat</aside></div>',
    ad: '<span data-a-target="video-ad-label">Ad</span>' },
  "kick.com": { name: "Kick", chans: { fakekicker: "Fake Kick Stream", "other-kicker": "Another Kick Stream" }, path: (c) => "/" + c,
    player: (inner) => '<div style="position:relative;width:900px;max-width:100%;aspect-ratio:16/9;background:#000"><video-player style="display:block;width:100%;height:100%">' + inner + '</video-player></div><h1 data-testid="livestream-title">TITLE</h1>',
    ad: "<span>Ad 0:15</span>" },
  "rumble.com": { name: "Rumble", chans: { "v6abc12-fake-live-show": "Fake Rumble Live Show", "v6abc13-second-live-show": "Second Rumble Live Show" }, vod: { "v4xyz9-old-video": "Old Rumble Video" }, path: (c) => "/" + c + ".html", dvr: true,
    player: (inner) => '<div id="videoPlayer" style="position:relative;width:960px;max-width:100%;aspect-ratio:16/9;background:#000">' + inner + '</div><h1 class="h1">TITLE</h1>',
    ad: "<span>Ad 1 of 2 · 0:10</span>" },
};
const liveSite = (host) => {
  const S = LIVE_SITES[host];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${S.name}</title><style>body{margin:0;background:#0e0e10;color:#fff;font-family:sans-serif}video{width:100%;height:100%;display:block}
.adl{position:absolute;top:10px;left:10px;background:#ff0;color:#000;padding:2px 8px}</style></head><body><div id="app"></div><script>
${livePlayer}
const S = ${JSON.stringify({ name: S.name, chans: S.chans, vod: S.vod || {}, dvr: !!S.dvr, ad: S.ad })};
const PATH = ${S.path.toString()}, PLAYER = ${S.player.toString()};
function render() {
  const p = location.pathname.replace(/\\.html$/, "").replace(/\\/$/, "").slice(1), app = document.getElementById("app");
  const t = S.chans[p] || S.vod[p];
  if (!t) { document.title = S.name; app.innerHTML = '<div style="padding:40px"><h1>' + S.name + ' home</h1></div>'; return; }
  document.title = t + " - " + S.name;
  const other = Object.keys(S.chans).find((k) => k !== p);
  app.innerHTML = PLAYER('<video id="lv" muted autoplay></video>').replace("TITLE", t) + '<a id="other" href="' + PATH(other) + '">Another stream</a>';
  document.getElementById("other").onclick = (e) => { e.preventDefault(); window.__go(PATH(other)); };
  const v = document.getElementById("lv");
  if (S.chans[p]) window.__livePlayer(v, { dvr: S.dvr });
  else { v.src = "/test.webm"; v.play().catch(() => {}); }
}
window.__go = (p) => { history.pushState(null, "", p); render(); };
window.__ad = (on) => {
  const box = document.getElementById("lv").parentElement;
  let n = box.querySelector("#adl");
  if (on && !n) { const d = document.createElement("div"); d.id = "adl"; d.innerHTML = S.ad; d.firstChild.classList.add("adl"); box.append(d); }
  if (!on && n) n.remove();
};
addEventListener("popstate", render);
render();
setTimeout(() => history.replaceState(null, "", location.pathname), 50);
window.__hotkeys = 0;
window.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter" || e.key === "f") { e.preventDefault(); e.stopPropagation(); window.__hotkeys++; } }, true);
</script></body></html>`;
};
function serveLive(req, res) {
  const u = req.url.split("?")[0];
  if (u === "/livesim/clock") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ t0: LIVE_T0, now: Date.now() }));
  }
  const m = u.match(/^\/livesim\/(init|seg-(\d+))\.webm$/);
  // a segment exists only once the "broadcast" has reached its end
  if (!m || (m[2] && +m[2] * 2000 > Date.now() - LIVE_T0)) {
    res.writeHead(404, { "cache-control": "no-store" });
    return res.end();
  }
  const f = path.join(LIVE_DIR, m[0].split("/").pop());
  if (!fs.existsSync(f)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "content-type": "video/webm", "cache-control": "no-store" });
  res.end(fs.readFileSync(f));
}

// ---- a video whose loading the test controls (buffer-aware sync): /gate.webm?g=<name>. While gate <name> is
// closed, a response sends at most the first GATE_HEAD bytes and holds the rest (a seek further in waits too);
// http://localhost:8444/__gate?g=<name>&open=0|1 closes / opens it.
const gates = new Map();
const GATE_HEAD = 400_000;
const gateOf = (n) => (gates.has(n) || gates.set(n, { open: true, waiters: [] }), gates.get(n));
function serveGate(req, res, name) {
  const g = gateOf(name);
  const range = req.headers.range;
  let start = 0, end = video.length - 1;
  if (range) {
    const [s0, e0] = range.replace("bytes=", "").split("-");
    start = +s0;
    end = e0 ? Math.min(+e0, video.length - 1) : video.length - 1;
  }
  res.writeHead(range ? 206 : 200, { "content-type": "video/webm", "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${video.length}` } : {}), "content-length": end - start + 1 });
  if (g.open) return res.end(video.subarray(start, end + 1));
  const head = Math.min(end + 1, GATE_HEAD);
  if (start < head) res.write(video.subarray(start, head));
  const from = Math.max(start, head);
  g.waiters.push(() => !res.destroyed && res.end(video.subarray(from, end + 1)));
}

// mock KLIPY media (static.klipy.com is mapped here by the browser's host-resolver-rules)
https.createServer({ key: fs.readFileSync(path.join(MEDIA_DIR, "key.pem")), cert: fs.readFileSync(path.join(MEDIA_DIR, "cert.pem")) }, (req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  if (/klipy\.com$/.test(host)) {
    if (/^\/test\/.+\.gif/.test(req.url)) {
      res.writeHead(200, { "content-type": "image/gif", "content-length": gif.length, "access-control-allow-origin": "*" });
      return res.end(gif);
    }
    res.writeHead(404);
    return res.end();
  }
  if (req.url.startsWith("/gate.webm")) return serveGate(req, res, new URL(req.url, "https://x").searchParams.get("g") || "x");
  if (host === "play.max.com") {
    // the old HBO Max address goes to the new one
    res.writeHead(301, { location: "https://play.hbomax.com" + req.url });
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
  if (host === "play.hbomax.com" || host === "www.crunchyroll.com" || host === "www.sonyliv.com" || (host === "static.crunchyroll.com" && req.url.startsWith("/vilos-v2/web/vilos/player.html"))) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(host === "play.hbomax.com" ? hbo : host === "www.crunchyroll.com" ? cr : host === "www.sonyliv.com" ? sl : vilos);
  }
  if (req.url.startsWith("/livesim/")) return serveLive(req, res);
  if (LIVE_SITES[host]) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(liveSite(host));
  }
  if (S24[host]) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(site24(host));
  }
  if (host === "www.primevideo.com" || host === "www.amazon.co.uk") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(pv);
  }
  if (host === "www.youtube.com") {
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": "require-trusted-types-for 'script'; trusted-types fake; script-src 'nonce-ytfake' 'strict-dynamic'" });
    return res.end(yt.replace("/*LIVEPLAYER*/", livePlayer));
  }
  const headers = { "content-type": "text/html" };
  if (CSP === "strict" && host === "www.netflix.com") headers["content-security-policy"] = "img-src 'self' blob:";
  // CSP=script: a page script-src that only allows the site's own and inline scripts (extension-injected <script src> must cope)
  if (CSP === "script" && (host === "www.netflix.com" || host === "www.hotstar.com")) headers["content-security-policy"] = "script-src 'self' 'unsafe-inline'; img-src 'self' blob:";
  // per browser (avatars.mjs): cookie npimg=none -> img-src 'self' (no blob:, no data:: pictures must use a <canvas>),
  // npimg=data -> img-src 'self' data: (no blob:)
  const npimg = (/(?:^|;\s*)npimg=(none|data)/.exec(req.headers.cookie || "") || /[?&]npimg=(none|data)/.exec(req.url) || [])[1];
  if (npimg && host === "www.netflix.com") headers["content-security-policy"] = npimg === "none" ? "img-src 'self'" : "img-src 'self' data:";
  res.writeHead(200, headers);
  res.end(app);
}).listen(8443, () => console.log("fake site on 8443" + (CSP ? " (CSP " + CSP + ")" : "")));

// mock KLIPY API (Tenor-compatible v2 shape); /__last shows the last search
let last = null;
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/__gate") {
    const g = gateOf(u.searchParams.get("g") || "x");
    g.open = u.searchParams.get("open") === "1";
    if (g.open) g.waiters.splice(0).forEach((f) => f());
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ open: g.open }));
  }
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
