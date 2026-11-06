import path from "node:path";
import { MEDIA_DIR } from "../config.mjs";
// 2.2 profile pictures in Firefox (AMO build) with a Chromium guest. The Firefox host's fake Netflix sends a strict
// image CSP: img-src 'self' (NPIMG=none, default) or img-src 'self' data: (NPIMG=data). Firefox, like Chromium,
// doesn't apply the page's CSP to the content script's own images, so they still show from blob: URLs (the data: and
// <canvas> fallbacks are exercised in avatars.mjs). Chromium guest: HD Robot, then an uploaded photo; Firefox
// uploads a photo too (createImageBitmap + WebP encoding in Firefox).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import { launchFF, extPage, tapTLS } from "./fflib.mjs";
import { launch, shadow, until, people, check, summary, out, sleep, keyOf, leaks } from "../lib.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const NPIMG = process.env.NPIMG || "none";
const PHOTO = path.join(MEDIA_DIR, "photo.png");
if (!fs.existsSync(PHOTO)) execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x400", "-frames:v", "1", PHOTO]);
const T = tapTLS(8792, 8787);
const H = await launchFF("ff-av", { uuid: "aaaaaaaa-0000-4000-8000-000000000016" });
const he = await extPage(H);
await he.evaluate((u) => chrome.storage.sync.set({ serverUrl: u, name: "Foxy", avatar: "av:fox" }), T.url);
const G = await launch("pw-ffav", { name: "Chromy", avatar: "av:robot", extra: { serverUrl: T.url } });
const hp = await H.browser.newPage();
const r = await hp.goto("https://www.netflix.com/watch/12345?npimg=" + NPIMG, { waitUntil: "domcontentloaded" });
out("host page CSP:", r?.headers()["content-security-policy"]);
await sleep(2500);
await hp.bringToFront();
const created = await he.evaluate(async () => { const tabs = await chrome.tabs.query({}); const t = tabs.find((t) => /netflix/.test(t.url || "")); return chrome.tabs.sendMessage(t.id, { cmd: "create" }); });
check("Firefox host created a party", !!keyOf(created?.invite), JSON.stringify(created));
const gp = await G.ctx.newPage();
await gp.goto(created.invite);
await until(async () => /invited you/.test(await gp.textContent("h1")), 6000);
await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
check("Chromium guest joined", !!(await until(async () => (await people(gp)).length === 2 && (await people(hp)).length === 2, 20000)));
const pic = (p, name) => shadow(p, (r, a) => {
  const n = [...r.querySelectorAll(".np-person")].find((x) => x.querySelector(".np-pname").textContent === a);
  const h = n?.querySelector(".np-avatar-pic"), c = h?.firstElementChild;
  let px = 0;
  if (c?.localName === "canvas") px = c.getContext("2d").getImageData(c.width / 2, c.height / 2, 1, 1).data[3];
  return h ? { pk: h.dataset.pk || null, tag: c?.localName || null, src: c?.localName === "img" ? c.src.slice(0, 5) : null, w: c ? (c.localName === "img" ? c.naturalWidth : c.width) : 0, px, text: c ? "" : h.textContent, photo: h.classList.contains("np-pic-photo") } : null;
}, name);
const mode = (x) => (x?.tag === "canvas" ? (x.px > 0 ? "canvas" : "blank canvas") : x?.tag === "img" ? (x.w > 0 ? x.src : "broken img") : "none");
const robot = await until(async () => { const x = await pic(hp, "Chromy"); return x?.pk === "av:robot" && x.tag && x; }, 10000);
const drawn = (x) => ["canvas", "blob:", "data:"].includes(mode(x));
check(`Firefox, page CSP img-src ${NPIMG === "none" ? "'self'" : "'self' data:"}: the guest's HD picture is drawn`, drawn(robot) && robot.w === 128, JSON.stringify(robot));
const own = await until(async () => { const x = await pic(hp, "You"); return x?.pk === "av:fox" && x.tag && x; }, 8000);
check("Firefox: your own HD picture is drawn too", drawn(own), JSON.stringify(own));
check("Chromium sees the Firefox host's HD fox", !!(await until(async () => { const x = await pic(gp, "Foxy"); return x?.pk === "av:fox" && x.tag === "img" && x.w === 128; }, 8000)));
// the guest uploads a photo (Chromium, through the picker)
await gp.locator(".np-person.np-me").click();
await gp.locator(".np-avatar-pop input[type=file]").setInputFiles(PHOTO);
const ph = await until(async () => { const x = await pic(hp, "Chromy"); return x?.photo && x.tag && x; }, 10000);
check("Firefox shows the guest's photo", drawn(ph) && ph.w === 96, JSON.stringify(ph));
// Firefox makes a photo too (createImageBitmap + canvas WebP encode in Firefox)
await hp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-person.np-me").click());
await sleep(500);
const input = await hp.$("pierce/.np-avatar-pop input[type=file]");
let uploaded = false;
try {
  await input.uploadFile(PHOTO);
  uploaded = true;
} catch (e) {
  out("uploadFile not supported here:", String(e).slice(0, 160));
}
if (uploaded) {
  const stored = await until(async () => (await he.evaluate(() => chrome.storage.local.get("avatarPhoto"))).avatarPhoto, 8000);
  check("Firefox upload: a ≤ 9 KB WebP/JPEG photo in storage.local", !!stored && /^data:image\/(webp|jpeg);base64,/.test(stored) && stored.length <= 12400, (stored || "").slice(0, 30) + " " + (stored || "").length);
  check("Chromium sees the Firefox host's photo", !!(await until(async () => { const x = await pic(gp, "Foxy"); return x?.photo && x.w === 96; }, 10000)));
}
check("no photo bytes or av: values in any frame", leaks(T.frames, ["data:image", "av:fox", "av:robot", "Foxy", "Chromy"]).length === 0);
const f = summary("FIREFOX AVATAR");
await H.browser.close(); await G.ctx.close(); T.close();
process.exit(f ? 1 : 0);
