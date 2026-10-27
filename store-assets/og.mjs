// 1200x630 link-preview (Open Graph) image for netparty.tech -> server/worker/site/og.jpg
import { chromium } from "/workspace/work/pw/node_modules/playwright/index.mjs";
import fs from "node:fs";
const D = "/workspace/work/store", f = (p) => "file://" + p;
const MARK = fs.readFileSync(`${D}/out/icons/netparty-icon.svg`, "utf8").replace(/width="512" height="512"/, 'width="100%" height="100%"');
const html = `<!doctype html><meta charset=utf-8><style>
@font-face{font-family:Inter;font-weight:400;src:url(${f(D + "/fonts/inter-400.ttf")})}
@font-face{font-family:Inter;font-weight:600;src:url(${f(D + "/fonts/inter-600.ttf")})}
@font-face{font-family:Inter;font-weight:800;src:url(${f(D + "/fonts/inter-800.ttf")})}
*{box-sizing:border-box;margin:0}html,body{width:1200px;height:630px;overflow:hidden}
body{font-family:Inter,sans-serif;color:#fff;position:relative;background:radial-gradient(700px 520px at 0% 0%,rgba(124,92,255,.55),transparent 65%),radial-gradient(700px 520px at 100% 100%,rgba(176,92,255,.42),transparent 65%),#0c0a14}
.l{position:absolute;left:72px;top:50%;transform:translateY(-50%);width:470px}
.b{display:flex;align-items:center;gap:14px}.m{width:62px;height:62px}.b span{font-weight:800;font-size:36px}
h1{font-weight:800;font-size:60px;letter-spacing:-.025em;line-height:1.04;margin-top:30px}
p{font-size:22px;color:#d6cff2;margin-top:18px;line-height:1.4}
.chips{display:flex;gap:10px;margin-top:26px}.chips span{padding:8px 15px;border-radius:999px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.07);font-weight:600;font-size:16px}
img{position:absolute;left:580px;top:110px;width:680px;border-radius:16px;border:1px solid rgba(255,255,255,.14);box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 70px rgba(124,92,255,.4)}
</style><div class=l><div class=b><div class=m>${MARK}</div><span>NetParty</span></div>
<h1>Watch together, in sync.</h1><p>Synced playback, encrypted chat and voice. Free and open source.</p>
<div class=chips><span>Netflix</span><span>JioHotstar</span><span>YouTube</span></div></div>
<img src="${f(D + "/raw/chat.png")}">`;
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-proxy-server", "--allow-file-access-from-files"] });
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
fs.writeFileSync("/tmp/og.html", html);
await p.goto("file:///tmp/og.html"); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
await p.screenshot({ path: "../server/worker/site/og.jpg", type: "jpeg", quality: 88 });
await b.close();
