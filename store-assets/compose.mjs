import { chromium } from "/workspace/work/pw/node_modules/playwright/index.mjs";
import fs from "node:fs";
const D = "/workspace/work/store", O = D + "/out";
for (const d of ["screenshots-1280x800", "screenshots-opera-612x408", "promo", "icons"]) fs.mkdirSync(`${O}/${d}`, { recursive: true });
const f = (p) => "file://" + p;
const MARK = fs.readFileSync(`${O}/icons/netparty-icon.svg`, "utf8").replace(/width="512" height="512"/, 'width="100%" height="100%"');
const css = `@font-face{font-family:Inter;font-weight:400;src:url(${f(D + "/fonts/inter-400.ttf")})}
@font-face{font-family:Inter;font-weight:600;src:url(${f(D + "/fonts/inter-600.ttf")})}
@font-face{font-family:Inter;font-weight:800;src:url(${f(D + "/fonts/inter-800.ttf")})}
*{box-sizing:border-box;margin:0}html,body{width:100%;height:100%;overflow:hidden}
body{font-family:Inter,sans-serif;color:#fff;position:relative;
background:radial-gradient(900px 520px at 12% -10%,rgba(124,92,255,.42),transparent 60%),radial-gradient(800px 500px at 100% 110%,rgba(176,92,255,.34),transparent 60%),#0c0a14}
.grad{background:linear-gradient(90deg,#9d85ff,#c98bff);-webkit-background-clip:text;background-clip:text;color:transparent}`;
const shots = [
  ["01-sync", "chat.png", "Watch together, <span class=grad>perfectly in sync</span>", "Netflix, JioHotstar and YouTube. Play, pause and skip together."],
  ["02-chat", "chat-neon.png", "Chat <span class=grad>beside</span> the video, not on top", "The player shrinks to make room. Hide the panel any time."],
  ["03-reactions", "reactions.png", "Reactions that <span class=grad>fly</span>", "Tap an emoji and it floats up on everyone's screen."],
  ["04-voice", "voice.png", "Talk like you're on <span class=grad>the same couch</span>", "Built-in voice chat, straight between friends."],
];
const shotHtml = (img, title, sub, W, H) => {
  const iw = Math.round(W * 0.8), ih = Math.round(iw * 0.625), top = H - ih;
  return `<style>${css}
  h1{position:absolute;top:${Math.round(top * 0.24)}px;left:0;right:0;text-align:center;font-weight:800;font-size:${Math.round(W * 0.034)}px;letter-spacing:-.02em}
  p{position:absolute;top:${Math.round(top * 0.24 + W * 0.047)}px;left:0;right:0;text-align:center;font-size:${Math.round(W * 0.0155)}px;color:#c4bde3}
  img{position:absolute;left:${(W - iw) / 2}px;top:${top}px;width:${iw}px;height:${ih}px;border-radius:16px 16px 0 0;border:1px solid rgba(255,255,255,.14);border-bottom:0;box-shadow:0 -10px 80px rgba(124,92,255,.35),0 30px 80px rgba(0,0,0,.6)}
  </style><h1>${title}</h1><p>${sub}</p><img src="${f(D + "/raw/" + img)}">`;
};
const privacyHtml = (W, H) => {
  const s = W / 1280;
  return `<style>${css}
  .wrap{position:absolute;inset:0;transform:scale(${s});transform-origin:0 0;width:1280px;height:${H / s}px}
  .l{position:absolute;left:96px;top:50%;transform:translateY(-50%);width:560px}
  h1{font-weight:800;font-size:52px;letter-spacing:-.02em;line-height:1.08}
  ul{list-style:none;padding:0;margin-top:34px}li{display:flex;gap:14px;align-items:flex-start;font-size:21px;color:#ddd8f3;margin:0 0 20px;line-height:1.35}
  li b{flex:none;width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#7C5CFF,#B05CFF);display:grid;place-items:center;font-size:16px}
  .chips{display:flex;gap:10px;margin-top:30px}.chips span{padding:9px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);font-weight:600;font-size:16px}
  .r{position:absolute;right:96px;top:50%;transform:translateY(-50%);width:420px}
  .card{border-radius:18px;overflow:hidden;border:1px solid rgba(255,255,255,.14);box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 60px rgba(124,92,255,.3)}
  .card img{display:block;width:100%}
  .link{margin-top:18px;padding:16px 18px;border-radius:14px;background:#17141f;border:1px solid rgba(255,255,255,.12);font:500 16px/1.3 ui-monospace,monospace;color:#cfc8ef}
  .link small{display:block;font:600 12px Inter;letter-spacing:.08em;text-transform:uppercase;color:#9d85ff;margin-bottom:6px}
  .link em{font-style:normal;color:#c98bff}
  </style><div class=wrap><div class=l><h1>Private <span class=grad>by design</span></h1><ul>
  <li><b>🔒</b>Chat, names and reactions are end-to-end encrypted in your browser.</li>
  <li><b>🔑</b>The key lives only in your invite link. Not even our server can read your chat.</li>
  <li><b>✨</b>No account, no sign-up. Open a title and start a party.</li></ul>
  <div class=chips><span>Netflix</span><span>JioHotstar</span><span>YouTube</span></div></div>
  <div class=r><div class=card><img src="${f(D + "/raw/popup-crop.png")}"></div>
  <div class=link><small>Invite link</small>netparty.tech/j/egfqxoyu<em>#k=•••••••••••</em></div></div></div>`;
};
const small = `<style>${css}
body{background:radial-gradient(300px 220px at 0% 0%,rgba(124,92,255,.55),transparent 70%),radial-gradient(320px 240px at 100% 100%,rgba(176,92,255,.45),transparent 70%),#0f0c19}
.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.m{width:84px;height:84px}h1{font-weight:800;font-size:42px;letter-spacing:-.02em;margin-top:10px}p{font-size:17px;color:#d4cdf0;margin-top:6px}</style>
<div class=c><div class=m>${MARK}</div><h1>NetParty</h1><p>Watch together, in sync.</p></div>`;
const marquee = `<style>${css}
body{background:radial-gradient(700px 500px at 0% 0%,rgba(124,92,255,.5),transparent 65%),radial-gradient(700px 500px at 100% 100%,rgba(176,92,255,.4),transparent 65%),#0c0a14}
.l{position:absolute;left:100px;top:50%;transform:translateY(-50%);width:520px}
.b{display:flex;align-items:center;gap:14px}.m{width:60px;height:60px}.b span{font-weight:800;font-size:34px}
h1{font-weight:800;font-size:58px;letter-spacing:-.025em;line-height:1.05;margin-top:30px}p{font-size:21px;color:#d0c9ee;margin-top:18px;line-height:1.4}
img{position:absolute;left:650px;top:68px;width:680px;border-radius:16px;border:1px solid rgba(255,255,255,.14);box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 70px rgba(124,92,255,.35)}</style>
<div class=l><div class=b><div class=m>${MARK}</div><span>NetParty</span></div><h1>Movie night, <span class=grad>together.</span></h1><p>Synced playback, encrypted chat and voice on Netflix, JioHotstar and YouTube.</p></div>
<img src="${f(D + "/raw/chat.png")}">`;
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-proxy-server", "--allow-file-access-from-files"] });
async function render(html, W, H, path, transparent = false) {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  fs.writeFileSync("/tmp/c.html", `<!doctype html><meta charset=utf-8>${html}`);
  await p.goto("file:///tmp/c.html"); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
  await p.screenshot({ path, omitBackground: transparent }); await p.close();
}
for (const [n, img, t, s] of shots) {
  await render(shotHtml(img, t, s, 1280, 800), 1280, 800, `${O}/screenshots-1280x800/${n}.png`);
  await render(shotHtml(img, t, s, 1224, 816), 1224, 816, `/tmp/opera-${n}.png`);
}
await render(privacyHtml(1280, 800), 1280, 800, `${O}/screenshots-1280x800/05-private.png`);
await render(privacyHtml(1224, 816), 1224, 816, `/tmp/opera-05-private.png`);
await render(small, 440, 280, `${O}/promo/small-promo-440x280.png`);
await render(marquee, 1400, 560, `${O}/promo/marquee-1400x560.png`);
// icons from the SVG masters
const ic = (svg, px) => `<style>html,body{margin:0;background:transparent}svg{display:block;width:${px}px;height:${px}px}</style>${fs.readFileSync(`${O}/icons/${svg}`, "utf8")}`;
for (const px of [16, 32, 48, 64, 96, 128, 256, 512]) await render(ic("netparty-icon.svg", px), px, px, `${O}/icons/icon-${px}.png`, true);
await render(ic("netparty-store-icon-128.svg", 128), 128, 128, `${O}/icons/store-icon-128.png`, true);
await render(ic("netparty-store-logo-300.svg", 300), 300, 300, `${O}/icons/store-logo-300.png`, true);
await b.close();
console.log("ok");
