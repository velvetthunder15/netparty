import path from "node:path";
import { pathToFileURL } from "node:url";
import { E2E, REPO, MEDIA_DIR, SERVER_LOG, tempPath } from "./config.mjs";
// 2.2 profile pictures (fake Netflix): the 48 bundled HD pictures (Fluent Emoji 3D) and your own photo.
// Browsers: host Chirag (2.2, dark, HD fox), guest Rahul (2.2, light, emoji 🐼 -> Robot -> photo -> 🐙), a real 2.1.0
// build from git ("Oldie", sees the emoji fallback), "Canvy" (2.2, no avatar set: the install default; page CSP
// img-src 'self') and "Dana" (2.2, page CSP img-src 'self' data:), and a scripted member that sends broken and hostile
// profiles. Canvy's and Dana's extension world refuses blob: (and data:) image loads (see blockImages), so the data:
// and <canvas> fallbacks are exercised. Everything goes through a recording proxy: no frame may carry the photo, an
// "av:" value or a name. CSP=strict: the host's and guest's fake Netflix also sends img-src 'self' blob:.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { launch, until, people, check, summary, out, sleep, tap, leaks, keyOf } from "./lib.mjs";
import { WebSocket } from "ws";
const SITE = "https://www.netflix.com/watch/12345";
const T = tap(8796, 8787);
await import(pathToFileURL(path.join(REPO, "extension", "emoji-data.js")).href); // sets globalThis.NP_EMOJI
const hd = globalThis.NP_EMOJI.hd;

const oldBuild = (rev, name) => {
  const dir = tempPath(name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // argument arrays: checkout paths with spaces work and the revision is never shell code
  const archive = execFileSync("git", ["-C", REPO, "archive", "--format=tar", rev, "extension"]);
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  return dir + "/extension";
};
const OLD21 = oldBuild(process.env.OLD21 || "761eb86e27cdb44e46c423e4607b8de073fe1f30", "np-av-old21");
// a 640 x 400 test photo (not square: it gets centre-cropped)
const PHOTO = path.join(MEDIA_DIR, "photo.png");
if (!fs.existsSync(PHOTO)) execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x400", "-frames:v", "1", PHOTO]);

const H = await launch("pw-avh", { name: "Chirag", avatar: "av:fox", extra: { serverUrl: T.url, theme: "dark" } });
const G = await launch("pw-avg", { name: "Rahul", avatar: "🐼", extra: { serverUrl: T.url, theme: "light" } });
const O = await launch("pw-avo", { name: "Oldie", avatar: "🐢", extra: { serverUrl: T.url }, ext: OLD21 });
const C = await launch("pw-avc", { name: "Canvy", extra: { serverUrl: T.url } });
const D = await launch("pw-avd", { name: "Dana", avatar: "av:owl", extra: { serverUrl: T.url } });
await C.ctx.addCookies([{ name: "npimg", value: "none", domain: "www.netflix.com", path: "/", secure: true }]);
await D.ctx.addCookies([{ name: "npimg", value: "data", domain: "www.netflix.com", path: "/", secure: true }]);
const hp = await H.ctx.newPage(), gp = await G.ctx.newPage(), op = await O.ctx.newPage(), cp = await C.ctx.newPage(), dp = await D.ctx.newPage();
const errors = [], requests = [];
const watch = (p, n) => {
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  p.on("console", (m) => {
    if (m.type() === "error" && !/Content Security Policy|ERR_|status of 40|Failed to load resource/.test(m.text())) errors.push(n + " console: " + m.text());
  });
  p.on("request", (r) => requests.push(r.url()));
};
for (const [p, n] of [[hp, "host"], [gp, "guest"], [op, "old"], [cp, "canvy"], [dp, "dana"]]) watch(p, n);

check("a new install starts with a random HD picture", /^av:[a-z-]+$/.test((await C.sw.evaluate(() => chrome.storage.sync.get("avatar"))).avatar || ""), JSON.stringify(await C.sw.evaluate(() => chrome.storage.sync.get("avatar"))));
const canvyHd = (await C.sw.evaluate(() => chrome.storage.sync.get("avatar"))).avatar;

await hp.goto(SITE);
await hp.waitForTimeout(2000);
const created = await H.sw.evaluate(async (url) => {
  const [t] = await chrome.tabs.query({ url: url + "*" });
  return chrome.tabs.sendMessage(t.id, { cmd: "create" });
}, SITE);
check("party created", !!created?.invite, JSON.stringify(created));
const KEY = keyOf(created.invite);
const ROOM = created.invite.match(/\/j\/([a-z0-9]+)/)[1];
for (const p of [gp, op, cp, dp]) {
  await p.goto(created.invite);
  await Promise.all([p.waitForNavigation(), p.click("a.btn")]);
}
check("everyone joined (2.2 ×4 + 2.1.0)", !!(await until(async () => (await people(hp)).length === 5 && (await people(op)).length === 5 && (await people(cp)).length === 5, 30000)));

// Neither Chromium nor Firefox applies the page's CSP to images the extension's content script creates, so to
// exercise the data: and <canvas> fallbacks, Canvy's and Dana's content-script world gets an image loader that
// refuses blob: (Dana) or blob: and data: (Canvy) the way a blocking CSP would (an error event), through CDP
// in the extension's isolated world. Applies to pictures loaded from here on (Robot and the photo below).
async function blockImages(page, prefixes) {
  const cdp = await page.context().newCDPSession(page);
  const ctxs = [];
  cdp.on("Runtime.executionContextCreated", (e) => ctxs.push(e.context));
  await cdp.send("Runtime.enable");
  await sleep(300);
  const iso = ctxs.filter((c) => c.auxData?.type === "isolated" && /NetParty/.test(c.name) && c.auxData?.isDefault === false);
  for (const c of iso)
    await cdp.send("Runtime.evaluate", {
      contextId: c.id,
      expression: `(() => { const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src"); const block = ${JSON.stringify(prefixes)};
        Object.defineProperty(HTMLImageElement.prototype, "src", { configurable: true, get() { return d.get.call(this); },
          set(v) { if (block.some((b) => String(v).startsWith(b))) { setTimeout(() => this.dispatchEvent(new Event("error")), 0); return; } d.set.call(this, v); } }); return 1; })()`,
    });
  return iso.length;
}
check("image blocking set up in the extension's world (Canvy: blob:+data:, Dana: blob:)", (await blockImages(cp, ["blob:", "data:"])) >= 1 && (await blockImages(dp, ["blob:"])) >= 1);

// ---- helpers
const sh = (p, fn, arg) => p.evaluate(([src, a]) => { const r = document.getElementById("netparty-root")?.shadowRoot; return r ? new Function("return " + src)()(r, a) : null; }, [fn.toString(), arg]);
// the people row: name -> what its picture holder shows
const pics = (p) => sh(p, (r) => Object.fromEntries([...r.querySelectorAll(".np-person")].map((n) => {
  const h = n.querySelector(".np-avatar-pic"), c = h?.firstElementChild;
  let px = 0;
  if (c?.localName === "canvas") { const d = c.getContext("2d").getImageData(c.width / 2, c.height / 2, 1, 1).data; px = d[3]; }
  return [n.querySelector(".np-pname").textContent, {
    pk: h?.dataset.pk || null, hd: h?.classList.contains("np-pic-hd") || false, photo: h?.classList.contains("np-pic-photo") || false,
    tag: c?.localName || null, w: c ? (c.localName === "img" ? (c.complete ? c.naturalWidth : 0) : c.width) : 0, src: c?.localName === "img" ? c.src.slice(0, 5) : null,
    px, text: c ? "" : (h?.textContent || ""), cw: Math.round(c?.getBoundingClientRect().width || 0), hw: Math.round(n.querySelector(".np-avatar").getBoundingClientRect().width),
  }];
})));
const picOf = async (p, name) => (await pics(p))?.[name];
const drawn = (x) => !!x && (x.tag === "img" ? x.w > 0 : x.tag === "canvas" ? x.w > 0 && x.px > 0 : false);
const mode = (x) => (x?.tag === "canvas" ? "canvas" : x?.src === "blob:" ? "blob" : x?.src === "data:" ? "data" : "none");
const send = async (p, t) => { await p.locator(".np-input").click(); await p.keyboard.type(t); await p.keyboard.press("Enter"); };
const oldPic = (name) => sh(op, (r, name) => { const n = [...r.querySelectorAll(".np-person")].find((x) => x.querySelector(".np-pname").textContent === name); return n ? n.querySelector(".np-avatar-pic, .np-avatar")?.textContent.replace(/[^\p{Extended_Pictographic}\u200d\ufe0f]/gu, "") : null; }, name);
const STRICT = process.env.CSP === "strict";

// ---- HD pictures, shown to everyone
const hostOnGuest = await until(async () => { const x = await picOf(gp, "Chirag"); return drawn(x) && x; }, 10000);
check("guest sees the host's HD picture (fox), drawn inside the circle", !!hostOnGuest && hostOnGuest.pk === "av:fox" && hostOnGuest.hd && hostOnGuest.cw <= hostOnGuest.hw && hostOnGuest.cw >= hostOnGuest.hw * 0.7, JSON.stringify(hostOnGuest));
check(STRICT ? "strict page CSP (img-src 'self' blob:): shown from a blob: URL" : "shown from a blob: URL", mode(hostOnGuest) === "blob", mode(hostOnGuest));
const own = await until(async () => { const x = await picOf(hp, "You"); return drawn(x) && x; }, 8000);
check("host sees their own HD picture", !!own && own.pk === "av:fox");
const onCanvy = await until(async () => { const x = await picOf(cp, "Chirag"); return drawn(x) && x; }, 10000);
// Chromium doesn't apply the page's CSP to images the extension's content script creates (its isolated world has
// its own CSP), so these still show from blob:; Firefox does, and ffavatars.mjs checks the data: / <canvas> fallbacks there
check("page CSP img-src 'self' (no blob:, no data:): the HD picture still shows", !!onCanvy && onCanvy.pk === "av:fox", mode(onCanvy));
const onDana = await until(async () => { const x = await picOf(dp, "Chirag"); return drawn(x) && x; }, 10000);
check("page CSP img-src 'self' data: (no blob:): the HD picture still shows", !!onDana, mode(onDana));
const canvyOnHost = await until(async () => { const x = await picOf(hp, "Canvy"); return drawn(x) && x; }, 8000);
check("the install default HD picture reaches the party", !!canvyOnHost && canvyOnHost.pk === canvyHd, JSON.stringify(canvyOnHost));
const gOnHost = await picOf(hp, "Rahul");
check("emoji pictures still work (guest 🐼: text, no image)", gOnHost?.pk === "e🐼" && gOnHost.tag === null && gOnHost.text === "🐼", JSON.stringify(gOnHost));
const oldOnNew = await picOf(hp, "Oldie");
check("a 2.1.0 member's emoji shows on 2.2", oldOnNew?.text === "🐢", JSON.stringify(oldOnNew));
check("2.1.0 shows the host's matching emoji (🦊) instead of the HD fox", !!(await until(async () => (await oldPic("Chirag")) === "🦊", 8000)), String(await oldPic("Chirag")));
check("2.1.0 shows Dana's owl as 🦉", (await oldPic("Dana")) === "🦉", String(await oldPic("Dana")));

// ---- the picker
await gp.locator(".np-person.np-me").click();
const pop = gp.locator(".np-avatar-pop");
await until(() => pop.isVisible(), 3000);
const pk = await sh(gp, (r) => {
  const p = r.querySelector(".np-avatar-pop");
  const hdb = [...p.querySelectorAll(".np-avatar-hd")];
  return {
    hd: hdb.length, titles: hdb.map((b) => b.title), vals: hdb.map((b) => b.dataset.avatar), firstIsHd: p.querySelector(".np-avatar-opt")?.classList.contains("np-avatar-hd"),
    emoji: p.querySelectorAll(".np-avatar-grid:not(.np-hd-grid) .np-avatar-opt").length, up: !!p.querySelector(".np-photo-btn"), remove: p.querySelector(".np-photo-remove")?.hidden,
    file: p.querySelector("input[type=file]")?.accept, on: p.querySelector(".np-avatar-opt.np-on")?.dataset.avatar,
  };
});
check("picker: the 48 HD pictures first, labels as titles", pk.hd === 48 && pk.firstIsHd && JSON.stringify(pk.titles) === JSON.stringify(hd.map((x) => x.label)) && pk.vals.every((v, i) => v === "av:" + hd[i].id), JSON.stringify(pk).slice(0, 300));
check("picker: an Emoji section (28) and Upload photo; no Remove photo without a photo", pk.emoji === 28 && pk.up && pk.remove === true && pk.file === "image/*", JSON.stringify(pk));
check("picker: your current emoji is marked", pk.on === "🐼", String(pk.on));
const allDrawn = await until(() => sh(gp, (r) => [...r.querySelectorAll(".np-avatar-hd .np-opt-pic")].every((h) => { const c = h.firstElementChild; return c && (c.localName === "canvas" || (c.complete && c.naturalWidth === 128)); })), 10000);
check("picker: all 48 HD pictures drawn (128 px files)", !!allDrawn);
const ov = await sh(gp, (r) => { const p = r.querySelector(".np-avatar-pop"), s = p.querySelector(".np-avatar-scroll"); const pr = p.getBoundingClientRect(), panel = r.querySelector(".np-panel").getBoundingClientRect(); return { x: s.scrollWidth - s.clientWidth, inside: pr.right <= panel.right + 1 && pr.left >= panel.left - 1 && pr.bottom <= innerHeight + 1, scrolls: s.scrollHeight > s.clientHeight }; });
check("picker fits the panel (no sideways overflow; it scrolls)", ov.x <= 0 && ov.inside, JSON.stringify(ov));
await pop.screenshot({ path: "av-picker-light.png" });
await gp.locator('.np-avatar-hd[data-avatar="av:robot"]').click();
check("pick Robot: saved as av:robot, picker closes", !!(await until(async () => (await G.sw.evaluate(() => chrome.storage.sync.get("avatar"))).avatar === "av:robot" && !(await pop.isVisible()), 3000)));
check("host sees the guest's Robot", !!(await until(async () => { const x = await picOf(hp, "Rahul"); return drawn(x) && x.pk === "av:robot"; }, 8000)));
const robotC = await until(async () => { const x = await picOf(cp, "Rahul"); return drawn(x) && x.pk === "av:robot" && x; }, 8000);
check("blob: and data: blocked: the HD picture is drawn on a <canvas>", mode(robotC) === "canvas", JSON.stringify(robotC));
const robotD = await until(async () => { const x = await picOf(dp, "Rahul"); return drawn(x) && x.pk === "av:robot" && x; }, 8000);
check("blob: blocked: the HD picture is shown from a data: URL", mode(robotD) === "data", JSON.stringify(robotD));
check("2.1.0 sees 🤖", !!(await until(async () => (await oldPic("Rahul")) === "🤖", 8000)), String(await oldPic("Rahul")));
await hp.locator(".np-person.np-me").click();
await until(() => hp.locator(".np-avatar-pop").isVisible(), 3000);
await until(() => sh(hp, (r) => [...r.querySelectorAll(".np-avatar-hd .np-opt-pic")].every((h) => h.firstElementChild)), 8000);
await hp.locator(".np-avatar-pop").screenshot({ path: "av-picker-dark.png" });
await hp.keyboard.press("Escape");

// ---- your own photo
await gp.locator(".np-person.np-me").click();
await until(() => pop.isVisible(), 3000);
await gp.locator(".np-avatar-pop input[type=file]").setInputFiles(PHOTO);
const stored = await until(async () => (await G.sw.evaluate(() => chrome.storage.local.get("avatarPhoto"))).avatarPhoto, 8000);
const meta = stored ? await G.sw.evaluate(async (u) => { const b = await (await fetch(u)).blob(); const bm = await createImageBitmap(b); return { w: bm.width, h: bm.height, bytes: b.size, type: b.type }; }, stored) : null;
check("upload: 96 x 96 WebP ≤ 9 KB in chrome.storage.local", !!meta && meta.w === 96 && meta.h === 96 && meta.type === "image/webp" && meta.bytes <= 9000 && stored.length <= 12400, JSON.stringify(meta) + " " + (stored || "").length);
check("upload: not in chrome.storage.sync", !JSON.stringify(await G.sw.evaluate(() => chrome.storage.sync.get(null))).includes("data:image"));
const photoOnHost = await until(async () => { const x = await picOf(hp, "Rahul"); return drawn(x) && x.photo && x; }, 8000);
check("host sees the guest's photo (96 px, round, in the circle)", !!photoOnHost && photoOnHost.w === 96 && /^i\d+\./.test(photoOnHost.pk) && photoOnHost.cw === photoOnHost.hw, JSON.stringify(photoOnHost));
const photoOnCanvy = await until(async () => { const x = await picOf(cp, "Rahul"); return drawn(x) && x.photo && x; }, 8000);
check("blob: and data: blocked (and page CSP img-src 'self'): the photo is drawn on a <canvas>", !!photoOnCanvy && mode(photoOnCanvy) === "canvas" && photoOnCanvy.w === 96, JSON.stringify(photoOnCanvy));
const photoOnDana = await until(async () => { const x = await picOf(dp, "Rahul"); return drawn(x) && x.photo && x; }, 8000);
check("blob: blocked: the photo is shown from a data: URL", !!photoOnDana && mode(photoOnDana) === "data", JSON.stringify(photoOnDana));
check("the guest sees their own photo", !!(await until(async () => { const x = await picOf(gp, "You"); return drawn(x) && x.photo; }, 5000)));
check("2.1.0 still shows the emoji (🤖) for a member with a photo, and their name", (await oldPic("Rahul")) === "🤖" && (await people(op)).includes("Rahul"));
await send(gp, "photo hello");
const lineHost = await until(() => sh(hp, (r) => { const m = [...r.querySelectorAll(".np-msg")].find((x) => x.textContent.includes("photo hello")); const h = m?.querySelector(".np-mav"); const c = h?.firstElementChild; return c && h.classList.contains("np-pic-photo") && (c.localName === "canvas" || c.naturalWidth === 96) ? { cls: h.className, w: Math.round(c.getBoundingClientRect().width) } : null; }), 8000);
check("chat lines show the photo too", !!lineHost && lineHost.w >= 20, JSON.stringify(lineHost));
await gp.locator(".np-person.np-me").click();
await until(() => pop.isVisible(), 3000);
check("picker: Remove photo shown, Upload marked", await sh(gp, (r) => !r.querySelector(".np-photo-remove").hidden && r.querySelector(".np-photo-btn").classList.contains("np-on") && !r.querySelector(".np-avatar-opt.np-on")));
await gp.screenshot({ path: path.join(E2E, "av-photo-light.png") });
await gp.locator(".np-photo-remove").click();
check("Remove photo: gone from storage, back to Robot everywhere", !!(await until(async () => !(await G.sw.evaluate(() => chrome.storage.local.get("avatarPhoto"))).avatarPhoto && (await picOf(hp, "Rahul"))?.pk === "av:robot" && (await picOf(cp, "Rahul"))?.pk === "av:robot", 8000)));
check("the chat line follows", !!(await until(() => sh(hp, (r) => [...r.querySelectorAll(".np-msg")].find((x) => x.textContent.includes("photo hello"))?.querySelector(".np-mav")?.dataset.pk === "av:robot"), 5000)));
// picking an emoji (Emoji section) replaces a photo as well
await gp.locator(".np-person.np-me").click();
await gp.locator(".np-avatar-pop input[type=file]").setInputFiles(PHOTO);
await until(async () => (await picOf(hp, "Rahul"))?.photo, 8000);
await gp.locator(".np-person.np-me").click();
await gp.locator('.np-avatar-grid:not(.np-hd-grid) .np-avatar-opt[data-avatar="🐙"]').click();
check("choosing an emoji replaces the photo", !!(await until(async () => (await picOf(hp, "Rahul"))?.pk === "e🐙" && !(await G.sw.evaluate(() => chrome.storage.local.get("avatarPhoto"))).avatarPhoto && (await oldPic("Rahul")) === "🐙", 8000)));
const photoB64 = stored.split(",")[1];

// ---- a member sending broken or hostile pictures
const enc = new TextEncoder();
const cKey = await crypto.subtle.importKey("raw", Buffer.from(KEY, "base64url"), { name: "AES-GCM" }, false, ["encrypt"]);
async function seal(kind, pid, obj) {
  const json = enc.encode(JSON.stringify(obj));
  const pt = new Uint8Array(Math.max(64, Math.ceil(json.length / 64) * 64)).fill(0x20);
  pt.set(json);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`netparty/e2ee/v1|${ROOM}|${kind}|${pid}`) }, cKey, pt));
  return Buffer.concat([Buffer.from([1]), iv, ct]).toString("base64url");
}
const ws = new WebSocket(T.url);
await new Promise((r) => ws.once("open", r));
let seq = 0;
const replies = new Map();
ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "reply") replies.get(m.reqId)?.(m); });
const req = (type, data) => { const reqId = ++seq; ws.send(JSON.stringify({ type, reqId, data })); return new Promise((res, rej) => replies.set(reqId, (m) => (m.error ? rej(new Error(m.error)) : res(m.data)))); };
const snap = await req("join", { e2ee: 1, roomId: ROOM, cid: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex") });
const bad = [
  ["not an image (decode fails)", { name: "Bottie", avatar: "🤖", img: "data:image/png;base64,QUFBQUFBQUFBQUFB" }],
  ["an https URL", { name: "Bottie", avatar: "🤖", img: "https://evil.example/x.png" }],
  ["SVG", { name: "Bottie", avatar: "🤖", img: "data:image/svg+xml;base64,PHN2Zy8+" }],
  ["an unknown HD id", { name: "Bottie", avatar: "🤖", hd: "av:../../icons/icon128" }],
  ["an HD path in avatar", { name: "Bottie", avatar: "av:nope" }],
];
for (const [what, prof] of bad) {
  await req("profile", { ct: await seal("profile", snap.you, prof) });
  await sleep(900);
  const x = await picOf(hp, "Bottie");
  check(`hostile profile (${what}): emoji only, no image`, !!x && x.tag === null && (x.text === "🤖" || (what.includes("avatar") && x.text.length > 0)), JSON.stringify(x));
}
await req("profile", { ct: await seal("profile", snap.you, { name: "Bottie", avatar: "🤖", hd: "av:ghost", img: "x".repeat(20000) }) }).then(() => check("oversized photo: the server refuses it", false), () => check("oversized photo: the server refuses it", true));
check("no request to any outside image URL", !requests.some((u) => /evil\.example|avatars\/av-/.test(u)), requests.filter((u) => /evil|avatars/.test(u)).join(" "));
ws.close();

// ---- what the server saw
const secret = ["Chirag", "Rahul", "Oldie", "Canvy", "Dana", "Bottie", "photo hello", "av:fox", "av:robot", "av:owl", "av:ghost", canvyHd, photoB64.slice(200, 260), photoB64.slice(-80, -10), "data:image", KEY];
check("tap saw the traffic", T.frames.filter((f) => /"type":"profile"/.test(f.text)).length >= 8, String(T.frames.length));
check("no WebSocket frame contains a name, an av: value or photo bytes", leaks(T.frames, secret).length === 0, JSON.stringify(leaks(T.frames, secret)));
check("server log has none of it either", leaks([{ text: fs.readFileSync(SERVER_LOG, "utf8") }], secret).length === 0);

// ---- popup
const extId = H.sw.url().split("/")[2];
const pp = await H.ctx.newPage();
await pp.goto(`chrome-extension://${extId}/popup.html`);
await sleep(800);
const popInfo = await pp.evaluate(() => ({ btn: document.querySelector("#avatarBtn img")?.getAttribute("src"), hd: document.querySelectorAll("#avatarGrid .avatar-opt.hd img").length, emoji: document.querySelectorAll("#avatarGrid .avatar-opt:not(.hd)").length }));
check("popup: your HD picture on the button, 48 HD + 28 emoji in the grid", popInfo.btn === "avatars/av-fox.webp" && popInfo.hd === 48 && popInfo.emoji === 28, JSON.stringify(popInfo));
// (the popup's "You" section only shows on a site; opened as a page here, so it's shown by hand)
await pp.evaluate(() => { document.getElementById("vMe").classList.remove("hidden"); document.getElementById("avatarBtn").click(); });
await sleep(500);
const loaded = await pp.evaluate(() => [...document.querySelectorAll("#avatarGrid img")].filter((i) => i.complete && i.naturalWidth === 128).length);
check("popup: the HD pictures load", loaded === 48, String(loaded));
await pp.locator("#vMe").screenshot({ path: "av-popup.png" });
await pp.locator('#avatarGrid [data-avatar="av:penguin"]').click();
check("popup: picking Penguin updates the party", !!(await until(async () => (await picOf(gp, "Chirag"))?.pk === "av:penguin", 8000)));
check("no script errors on the pages", errors.length === 0, errors.join(" | "));

T.close();
const f = summary("AVATAR");
for (const x of [H, G, O, C, D]) await x.ctx.close();
process.exit(f ? 1 : 0);
