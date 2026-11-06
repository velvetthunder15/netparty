import { MEDIA_DIR } from "./config.mjs";
// Local test pages for "Sync any video" (2.0), plain http on two ports (two origins):
//   http://localhost:8450  the pages below
//   http://localhost:8451  /inner: a player page used as a cross-origin iframe
// Pages: /plain, /shadow (video in an open shadow root), /iframe (same-origin iframe), /xframe
// (cross-origin iframe), /swap (window.__swap() replaces the <video> mid-play, like an ad or next
// episode), /two (two similar videos: picker), /short (a 60 s video: duration mismatch), /live
// (canvas.captureStream: infinite duration), /canvas (canvas only, no <video>).
// Every page has window.__v() (the video the test drives) and window.__swap().
// Started by anyvideo.mjs itself (also importable: start()).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = MEDIA_DIR;
const media = {
  "/test.webm": fs.readFileSync(path.join(DIR, "test.webm")),
  "/test-short.webm": fs.readFileSync(path.join(DIR, "test-short.webm")),
};
const page = (title, body, script = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;background:#111;color:#eee;font:16px system-ui,sans-serif}main{padding:24px}video,iframe{display:block;background:#000}
.row{display:flex;gap:16px}</style></head><body><main><h1>${title}</h1>${body}</main>
<script>
window.__v = () => document.querySelector("video");
// replace the playing <video> with a new element at the same spot (keeps time and play state)
window.__swap = () => {
  const old = window.__v();
  const n = document.createElement("video");
  for (const a of ["src", "width", "height", "muted", "style"]) if (old.hasAttribute(a)) n.setAttribute(a, old.getAttribute(a));
  n.muted = true;
  const t = old.currentTime, playing = !old.paused;
  n.addEventListener("loadedmetadata", () => { n.currentTime = t; if (playing) n.play(); }, { once: true });
  old.replaceWith(n);
  return true;
};
// like a player page: clicks on the page body do nothing special; Space toggles play (a page hotkey)
window.__hotkeys = 0;
addEventListener("keydown", (e) => { if (e.key === " ") { e.preventDefault(); window.__hotkeys++; } }, true);
${script}
</script></body></html>`;
const VID = (src = "/test.webm", extra = "") => `<video src="${src}" width="640" height="360" muted autoplay playsinline ${extra}></video>`;

const pages = {
  "/plain": () => page("Plain video page", VID()),
  "/short": () => page("Short video page", VID("/test-short.webm")),
  "/swap": () => page("Swapping video page", VID()),
  "/two": () => page("Two videos", `<div class="row">${VID("/test.webm", 'id="a"')}${VID("/test.webm", 'id="b"')}</div>`, `window.__v = () => document.getElementById("b");`),
  "/shadow": () =>
    page(
      "Shadow DOM player",
      `<x-player></x-player>`,
      `customElements.define("x-player", class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: "open" }); r.innerHTML = '<div class="frame"><video src="/test.webm" width="640" height="360" muted autoplay playsinline></video></div>'; } });
window.__v = () => document.querySelector("x-player").shadowRoot.querySelector("video");
window.__swap = () => false;`,
    ),
  "/iframe": () =>
    page(
      "Same-origin iframe player",
      `<iframe src="/inner" width="680" height="400" style="border:0"></iframe>`,
      `window.__v = () => document.querySelector("iframe").contentDocument.querySelector("video");`,
    ),
  "/xframe": () => page("Cross-origin iframe player", `<iframe src="http://localhost:8451/inner" width="680" height="400" style="border:0" allow="autoplay; fullscreen"></iframe>`, `window.__v = () => null;`),
  "/inner": () => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#000}video{display:block}</style></head><body>${VID()}<script>window.__v = () => document.querySelector("video");</script></body></html>`,
  "/live": () =>
    page(
      "Live stream page",
      `<canvas id="c" width="320" height="180" style="display:none"></canvas><video id="lv" width="640" height="360" muted autoplay playsinline></video>`,
      `const c = document.getElementById("c"), g = c.getContext("2d"); let n = 0;
setInterval(() => { g.fillStyle = "hsl(" + (n++ * 7 % 360) + ",70%,40%)"; g.fillRect(0, 0, 320, 180); g.fillStyle = "#fff"; g.font = "40px sans-serif"; g.fillText(String(n), 20, 100); }, 66);
document.getElementById("lv").srcObject = c.captureStream(15);
window.__swap = () => false;`,
    ),
  "/canvas": () =>
    page(
      "Canvas-only player",
      `<canvas id="c" width="640" height="360"></canvas>`,
      `const g = document.getElementById("c").getContext("2d"); let n = 0; setInterval(() => { g.fillStyle = "hsl(" + (n++ % 360) + ",60%,40%)"; g.fillRect(0, 0, 640, 360); }, 50); window.__v = () => null;`,
    ),
};

function handler(req, res) {
  const u = new URL(req.url, "http://x");
  const m = media[u.pathname];
  if (m) {
    const range = req.headers.range;
    if (range) {
      const [s, e] = range.replace("bytes=", "").split("-");
      const start = +s, end = e ? +e : m.length - 1;
      res.writeHead(206, { "content-type": "video/webm", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${m.length}`, "content-length": end - start + 1 });
      return res.end(m.subarray(start, end + 1));
    }
    res.writeHead(200, { "content-type": "video/webm", "accept-ranges": "bytes", "content-length": m.length });
    return res.end(m);
  }
  const p = pages[u.pathname];
  if (!p) {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(p());
}

export function start() {
  const a = http.createServer(handler).listen(8450);
  const b = http.createServer(handler).listen(8451);
  return () => (a.close(), b.close());
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start();
  console.log("any-video test pages on http://localhost:8450 and :8451");
}
