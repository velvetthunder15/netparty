// Fake www.netflix.com / www.hotstar.com for extension e2e tests.
// A tiny single-page app: browse/detail pages with a Play button, and watch pages
// with a player, switched with history.pushState like the real sites.
import https from "node:https";
import fs from "node:fs";
const video = fs.readFileSync("test.webm");

const app = `<!doctype html><html><head><title>fake</title></head><body style="margin:0;background:#141414;color:#fff;font-family:sans-serif">
<div id="app"></div>
<script>
const HOT = /hotstar/.test(location.hostname);
const isWatch = () => HOT ? /\\/\\d{5,}\\/watch\\/?$/.test(location.pathname) : /^\\/watch\\/\\d+/.test(location.pathname);
const player = () => {
  const shell = HOT ? "hs-player-shell" : "watch-video", inner = HOT ? "hs-player-inner" : "watch-video--player-view";
  return '<div class="' + shell + '" style="position:fixed;inset:0;background:#000"><div class="' + inner + '" style="position:absolute;top:0;left:0;width:100%;height:100%">' +
    '<video id="v" src="/test.webm" muted autoplay style="position:absolute;top:0;left:0"></video>' +
    '<div class="controls" style="position:absolute;left:0;right:0;bottom:0;height:64px;display:flex;justify-content:space-between;align-items:center;padding:0 20px;background:linear-gradient(transparent,#000a)">' +
    '<button id="playbtn" style="font-size:20px">play</button><span>Fake Title ' + location.pathname + '</span><button id="fsbtn" style="font-size:20px">full</button></div></div></div>';
};
const netflixBrowse = () =>
  '<div style="padding:40px"><h1>Home</h1><div class="billboard"><p>A family reunion turns into a bloodbath.</p>' +
  '<div data-uia="billboard-actions" style="display:flex;align-items:center">' +
  '<div><button data-uia="play-video-button" id="nfplay" style="height:56px;padding:0 28px;border-radius:6px;border:0;font-size:20px;font-weight:700">Play</button></div>' +
  '<div style="margin-left:12px"><button id="moreinfo" style="height:56px;padding:0 28px;border-radius:6px;border:0;font-size:20px;background:#6d6d6eb3;color:#fff">More Info</button></div>' +
  '</div></div></div>';
const hotstarDetail = () =>
  '<div id="shimmerContainer" style="padding:40px"><h1>Fake Movie</h1><div class="w-full" style="width:320px">' +
  '<a href="' + location.pathname.replace(/\\/$/, "") + '/watch"><button style="width:320px;height:48px;border-radius:8px;border:0;font-size:18px">Watch Now</button></a></div></div>';
function render() {
  const app = document.getElementById("app");
  if (isWatch()) {
    app.innerHTML = player();
    // like Netflix: the player sizes the <video> in px from its container box
    const pv = app.querySelector("[class$=player-view], .hs-player-inner"), vid = document.getElementById("v");
    new ResizeObserver(() => { const r = pv.getBoundingClientRect(); vid.style.width = r.width + "px"; vid.style.height = r.height + "px"; }).observe(pv);
    // like a streaming site: router strips unknown query params
    setTimeout(() => history.replaceState(null, "", location.pathname), 50);
  } else if (HOT && /\\/in\\/movies\\//.test(location.pathname)) app.innerHTML = hotstarDetail();
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
</script></body></html>`;

https.createServer({ key: fs.readFileSync("key.pem"), cert: fs.readFileSync("cert.pem") }, (req, res) => {
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
  res.writeHead(200, { "content-type": "text/html" });
  res.end(app);
}).listen(8443, () => console.log("fake site on 8443"));
