// Fake www.netflix.com / www.hotstar.com watch pages for extension e2e tests.
import https from "node:https";
import fs from "node:fs";
const video = fs.readFileSync("test.webm");
const page = (title) => `<!doctype html><html><head><title>${title}</title></head><body style="margin:0;background:#000">
<div id="player" style="width:100vw;height:100vh"><video id="v" src="/test.webm" muted autoplay style="width:100%;height:100%"></video></div>
<script>
// like a streaming site: router strips unknown query params, hotkeys eat Space/Enter
setTimeout(() => history.replaceState(null, "", location.pathname), 50);
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
  res.end(page(req.headers.host + req.url));
}).listen(8443, () => console.log("fake site on 8443"));
