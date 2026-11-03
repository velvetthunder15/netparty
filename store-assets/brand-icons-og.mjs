import { chromium } from "/workspace/work/pw/node_modules/playwright/index.mjs";
import fs from "node:fs";
const D="/workspace/work/store", f=p=>"file://"+p;
const SITE="/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/server/worker/site";
const G=`<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7C5CFF"/><stop offset="1" stop-color="#B05CFF"/></linearGradient>`;
const PATHS=`<path d="M4 6a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-7l-5 4v-4.3A4 4 0 0 1 4 14z" fill="url(#g)" opacity=".55"/><path d="M10 14a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8a4 4 0 0 1-2 3.5V30l-5-4h-7a4 4 0 0 1-4-4z" fill="url(#g)"/><path d="M17 14.5v7l6-3.5z" fill="#fff"/>`;
// full-bleed square: dark tile, mark scaled 0.68 about the centre so it sits inside the circle Google crops to
const s=0.68, t=16*(1-s);
const FAV=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs>${G}<radialGradient id="h" cx=".3" cy=".2" r="1"><stop offset="0" stop-color="#2a1f4d"/><stop offset="1" stop-color="#0d0c12"/></radialGradient></defs><rect width="32" height="32" fill="url(#h)"/><g transform="translate(${t} ${t}) scale(${s})">${PATHS}</g></svg>`;
fs.writeFileSync(SITE+"/favicon.svg", FAV);
const MARK=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%"><defs>${G}</defs>${PATHS}</svg>`;
const b=await chromium.launch({executablePath:"/usr/bin/chromium",args:["--no-proxy-server","--allow-file-access-from-files"]});
async function shot(html,w,h,out,type="png"){const p=await b.newPage({viewport:{width:w,height:h}});fs.writeFileSync("/tmp/b.html",html);await p.goto("file:///tmp/b.html");await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(200);await p.screenshot({path:out,type,...(type==="jpeg"?{quality:88}:{})});await p.close();}
for (const n of [48,96,192,180]) await shot(`<style>*{margin:0}body{width:${n}px;height:${n}px}</style>${FAV.replace('<svg ','<svg width="'+n+'" height="'+n+'" ')}`,n,n,`${SITE}/${n===180?"apple-touch-icon":"favicon-"+n}.png`);
const css=(w,h)=>`@font-face{font-family:Inter;font-weight:400;src:url(${f(D+"/fonts/inter-400.ttf")})}@font-face{font-family:Inter;font-weight:600;src:url(${f(D+"/fonts/inter-600.ttf")})}@font-face{font-family:Inter;font-weight:800;src:url(${f(D+"/fonts/inter-800.ttf")})}
*{box-sizing:border-box;margin:0}html,body{width:${w}px;height:${h}px;overflow:hidden}
body{font-family:Inter,sans-serif;color:#fff;display:grid;place-items:center;text-align:center;background:radial-gradient(${w*.6}px ${h*.8}px at 50% 0%,rgba(124,92,255,.5),transparent 70%),radial-gradient(${w*.5}px ${h*.6}px at 50% 110%,rgba(176,92,255,.35),transparent 70%),#0c0a14}
.b{display:flex;align-items:center;justify-content:center;gap:22px}.m{width:110px;height:110px}.b span{font-weight:800;font-size:104px;letter-spacing:-.035em}
h1{font-weight:600;font-size:40px;letter-spacing:-.015em;margin-top:26px;color:#e9e4ff}
.chips{display:flex;gap:12px;justify-content:center;margin-top:34px;flex-wrap:wrap;max-width:720px}.chips span{padding:10px 18px;border-radius:999px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.07);font-weight:600;font-size:21px}`;
const body=`<div><div class=b><div class=m>${MARK}</div><span>NetParty</span></div><h1>Watch together, in sync.</h1><div class=chips><span>Netflix</span><span>Prime Video</span><span>JioHotstar</span><span>YouTube</span></div></div>`;
await shot(`<meta charset=utf-8><style>${css(1200,630)}</style>${body}`,1200,630,SITE+"/og.jpg","jpeg");
await shot(`<meta charset=utf-8><style>${css(1200,1200)}</style>${body}`,1200,1200,SITE+"/og-square.jpg","jpeg");
await b.close();
