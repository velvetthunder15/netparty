// 2.3 in Firefox (AMO build, Firefox ESR): a Firefox host (Foxy) with two Chromium guests (Chromy, Rahul).
// - share block: Copy link (real clipboard), WhatsApp opens its fixed start page, QR code opens in NetParty's own
//   window (moz-extension://…/qr.html) and decodes to the link; the panel draws none; closing it forgets the link
// - host controls from Firefox: lock (the Chromium guests see it, a new tab can't join), remove (two presses),
//   make host (the role moves to Chromium), and the old host stays a guest after a reload
// - per-person voice volume in Firefox, on top of the friends' slider
// - the recap in Firefox: drawn (1080 x 1350), Download link (PNG data: URL), Copy image
// - leak audit: no name, message or key in any WebSocket frame
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import { launchFF, extPage, tapTLS } from "./fflib.mjs";
import { launch, shadow, until, people, check, summary, out, sleep, keyOf, leaks, noticeText, status } from "../lib.mjs";
import jsQR from "jsqr";

const T = tapTLS(8794, 8787);
const SITE = "https://www.netflix.com/watch/12345";
const H = await launchFF("/tmp/ff-23", { uuid: "aaaaaaaa-0000-4000-8000-000000000023" });
const he = await extPage(H);
await he.evaluate((u) => chrome.storage.sync.set({ serverUrl: u, name: "Foxy", avatar: "🦊" }), T.url);
const G = await launch("/tmp/pw-ff23g", { name: "Chromy", avatar: "🐼", extra: { serverUrl: T.url } });
const R = await launch("/tmp/pw-ff23r", { name: "Rahul", avatar: "🐸", extra: { serverUrl: T.url } });
const errors = [];
const hp = await H.browser.newPage();
hp.on("pageerror", (e) => errors.push("firefox: " + (e?.message || e)));
await hp.goto(SITE, { waitUntil: "domcontentloaded" });
await sleep(2500);
await hp.bringToFront();
const ffTab = (msg) => he.evaluate(async (m) => { const t = (await chrome.tabs.query({})).find((t) => /netflix/.test(t.url || "")); return chrome.tabs.sendMessage(t.id, m); }, msg);
const created = await ffTab({ cmd: "create" });
const INVITE = created?.invite;
const KEY = keyOf(INVITE);
check("Firefox host created a party", !!KEY, JSON.stringify(created));
const ROOM = INVITE.match(/\/j\/([a-z0-9]+)/)[1];
const gp = await G.ctx.newPage();
const rp = await R.ctx.newPage();
for (const p of [gp, rp]) {
  await p.goto(INVITE);
  await until(async () => /invited you/.test((await p.textContent("h1")) || ""), 6000);
  await Promise.all([p.waitForNavigation(), p.click("a.btn")]);
}
check("both Chromium guests joined", !!(await until(async () => (await people(hp)).length === 3, 25000)), JSON.stringify(await people(hp)));

// a real mouse click on an element in the panel (the clipboard needs a real click in Firefox)
const realClick = async (p, sel, root = "netparty-root") => {
  const r = await p.evaluate(([s, id]) => { const n = document.getElementById(id)?.shadowRoot?.querySelector(s); if (!n) return null; n.scrollIntoView({ block: "nearest" }); const b = n.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, [sel, root]);
  if (!r) throw new Error("no " + sel);
  await p.mouse.click(r.x, r.y);
};
const sh = (p, fn, arg) => shadow(p, fn, arg);
const crownOf = (p) => p.evaluate(() => { const c = document.getElementById("netparty-root")?.shadowRoot?.querySelector(".np-crown"); return c && c.closest(".np-person")?.querySelector(".np-pname")?.textContent; });
// a real click on a friend's picture (moves the focus into the panel, so Esc closes its menu, as for a user)
const clickTile = async (p, name) => {
  const b = await p.evaluate((n) => { const r = document.getElementById("netparty-root").shadowRoot; const t = [...r.querySelectorAll(".np-person")].find((x) => x.querySelector(".np-pname")?.textContent === n); if (!t) return null; const q = t.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 3 }; }, name);
  if (!b) throw new Error("no tile " + name);
  await p.mouse.click(b.x, b.y);
};
const popOpen = (p, cls) => p.evaluate((c) => !!document.getElementById("netparty-root").shadowRoot.querySelector(`.${c}.np-pop-open`), cls);

// ---------------------------------------------------------------- share block in Firefox
await realClick(hp, ".np-invite");
check("Invite opens the share block (four options)", JSON.stringify(await sh(hp, (r) => { return [...r.querySelectorAll(".np-share-pop.np-pop-open .np-share-app")].map((b) => b.textContent); })) === '["WhatsApp","Discord","Instagram","QR code"]');
await realClick(hp, ".np-share-copy");
const pasted = await until(() => hp.evaluate(async () => { try { return await navigator.clipboard.readText(); } catch { return null; } }), 3000).catch(() => null);
const readable = typeof pasted === "string";
if (readable) check("Copy link: the full invite link on the clipboard", pasted === INVITE, String(pasted).replace(/#k=.*/, "#k=…"));
else check("Copy link: says it copied", /Invite link copied/.test(await sh(hp, (r) => { return r.querySelector(".np-share-msg").textContent; })));
await realClick(hp, '.np-share-pop .np-share-app[data-app="whatsapp"]');
const wa = await until(() => he.evaluate(() => chrome.tabs.query({}).then((ts) => ts.map((t) => t.url).find((u) => /whatsapp/.test(u || "")) || null)), 6000);
check("WhatsApp opens https://web.whatsapp.com/ (nothing in the address)", wa === "https://web.whatsapp.com/", String(wa));
await he.evaluate(() => chrome.tabs.query({}).then((ts) => Promise.all(ts.filter((t) => /whatsapp/.test(t.url || "")).map((t) => chrome.tabs.remove(t.id)))));
await hp.bringToFront();
if (!(await sh(hp, (r) => { return !!r.querySelector(".np-share-pop.np-pop-open"); }))) await realClick(hp, ".np-invite");
await realClick(hp, '.np-share-pop .np-share-app[data-app="qr"]');
// (puppeteer can list a page opened by windows.create under its first address, about:blank: ask each page)
const findQr = async () => {
  for (const p of await H.browser.pages()) {
    const u = await p.evaluate(() => location.href).catch(() => "");
    if (u.includes("/qr.html")) return p;
  }
  return null;
};
const qrPage = await until(findQr, 8000, 400);
let qrText = null;
if (qrPage) {
  await until(() => qrPage.evaluate(() => !document.getElementById("box").hidden), 5000);
  const px = await qrPage.evaluate(() => { const c = document.getElementById("qr"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height); return { w: c.width, h: c.height, data: Array.from(d.data) }; });
  qrText = jsQR(Uint8ClampedArray.from(px.data), px.w, px.h)?.data || null;
}
if (!qrPage) out("QR debug:", JSON.stringify({
  msg: await sh(hp, (r) => { return r.querySelector(".np-share-msg").textContent; }),
  pages: (await H.browser.pages()).map((p) => p.url()),
  wins: await he.evaluate(() => chrome.windows.getAll({ populate: true }).then((ws) => ws.map((w) => ({ id: w.id, type: w.type, urls: w.tabs.map((t) => t.url) })))),
  stored: await he.evaluate(() => chrome.storage.session.get(null).then((a) => Object.keys(a))),
}));
const qrUrl = qrPage ? await qrPage.evaluate(() => location.href) : null;
check("QR code opens in a moz-extension:// window and decodes to the invite link", /^moz-extension:\/\/[^/]+\/qr\.html\?tab=\d+$/.test(qrUrl || "") && qrText === INVITE, `${qrUrl} ${String(qrText).replace(/#k=.*/, "#k=…")}`);
check("the panel draws no QR code, and the key is nowhere in the page", (await sh(hp, (r) => { return !r.querySelector("canvas"); })) && !(await hp.content()).includes(KEY) && (await sh(hp, (r, a) => { return !r.innerHTML.includes(a); }, KEY)));
const qrKeys = () => he.evaluate(() => chrome.storage.session.get(null).then((a) => Object.keys(a).filter((k) => k.startsWith("qr:"))));
if (qrPage) await qrPage.close();
check("closing the QR window forgets the link", !!(await until(async () => (await qrKeys()).length === 0, 5000)));
await hp.bringToFront();
await hp.keyboard.press("Escape");

// ---------------------------------------------------------------- lock, remove, make host from Firefox
await realClick(hp, ".np-tool-set");
check("Firefox host: Settings has the party switches", !!(await until(() => sh(hp, (r) => { return [...r.querySelectorAll("[data-host-set]")].length === 2; }), 3000)));
await realClick(hp, '[data-host-set="locked"]');
check("locking from Firefox shows on Chromium ('· locked')", !!(await until(async () => /· locked/.test(await gp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-meta").textContent)), 6000)));
await hp.keyboard.press("Escape");
const np = await G.ctx.newPage();
await np.goto(INVITE);
check("the invite page says the party is locked", /This party is locked/.test((await np.textContent("h1")) || ""));
await np.close();
await realClick(hp, ".np-tool-set");
await realClick(hp, '[data-host-set="locked"]');
check("unlocked again", !!(await until(async () => !/locked/.test(await gp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-meta").textContent)), 6000)));
await hp.keyboard.press("Escape");
await clickTile(hp, "Rahul");
check("Rahul's menu (host): Make host + Remove", !!(await until(() => sh(hp, (r) => { return [...r.querySelectorAll(".np-member-pop.np-pop-open .np-menu-btn")].map((b) => b.textContent).join("|") === "Make host|Remove from party"; }), 3000)));
await realClick(hp, ".np-member-pop .np-menu-btn.np-danger");
check("Remove asks once more", (await sh(hp, (r) => { return r.querySelector(".np-member-pop .np-menu-btn.np-danger").textContent; })) === "Press again to remove Rahul");
await realClick(hp, ".np-member-pop .np-menu-btn.np-danger");
check("Rahul (Chromium) is told and out", !!(await until(async () => /The host removed you/.test(await noticeText(rp)) && !(await status(R, rp)).roomId, 8000)), await noticeText(rp));
check("Firefox: 'Rahul was removed from the party', 2 people", !!(await until(async () => (await people(hp)).length === 2 && (await sh(hp, (r) => { return [...r.querySelectorAll(".np-sys")].some((n) => n.textContent === "Rahul was removed from the party"); })), 6000)));

// ---------------------------------------------------------------- per-person volume in Firefox
await sh(gp, (r) => { r.querySelector(".np-join-voice")?.click(); });
await sleep(700);
await sh(hp, (r) => { r.querySelector(".np-join-voice")?.click(); });
const linked = (p) => sh(p, (r) => { return [...r.querySelectorAll(".np-person[data-link]")].map((n) => n.dataset.link).join(); });
check("voice connects Firefox ↔ Chromium", !!(await until(async () => (await linked(hp)) === "connected" && (await linked(gp)) === "connected", 25000)));
await clickTile(hp, "Chromy");
check("Chromy's menu has a volume slider", !!(await until(() => sh(hp, (r) => { return !!r.querySelector(".np-member-pop.np-pop-open .np-mm-vol"); }), 3000)));
await sh(hp, (r) => { const v = r.querySelector(".np-member-pop .np-mm-vol"); v.value = "40"; v.dispatchEvent(new Event("input")); });
const ffLevels = async () => (await ffTab({ cmd: "status" }))?.levels;
check("Chromy at 40% in Firefox", !!(await until(async () => (await ffLevels())?.Chromy === 0.4, 3000)), JSON.stringify(await ffLevels()));
await hp.keyboard.press("Escape");
check("Esc closes the friend's menu", !!(await until(async () => !(await popOpen(hp, "np-member-pop")), 2000)));
await sh(hp, (r) => { const v = r.querySelector(".np-vol"); v.value = "0.5"; v.dispatchEvent(new Event("input")); });
check("friends' slider at 50% on top (Chromy 20%)", !!(await until(async () => (await ffLevels())?.Chromy === 0.2, 3000)), JSON.stringify(await ffLevels()));

// some chat for the recap
const say = async (p, text) => {
  await p.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-input").focus());
  await p.keyboard.type(text);
  await p.keyboard.press("Enter");
};
for (const t of ["firefox popcorn FFMARK", "this scene", "wow"]) await say(hp, t);
await say(gp, "chromium agrees FFMARK");

// ---------------------------------------------------------------- make host -> Chromium
await clickTile(hp, "Chromy");
check("Chromy's menu opens again", !!(await until(() => popOpen(hp, "np-member-pop"), 3000)));
await realClick(hp, ".np-member-pop.np-pop-open .np-menu-btn:not(.np-danger)");
const promoted = await until(async () => (await crownOf(hp)) === "Chromy" && (await crownOf(gp)) === "You", 6000);
if (!promoted) out("make host debug:", JSON.stringify({ ffCrown: await crownOf(hp), gCrown: await crownOf(gp), sys: (await sh(hp, (r) => { return [...r.querySelectorAll(".np-sys")].map((n) => n.textContent); })).slice(-4) }));
check("Chromy is the host now (both browsers)", !!promoted);
await hp.reload({ waitUntil: "domcontentloaded" });
check("Firefox (old host) reloads as a guest", !!(await until(async () => { const s = await ffTab({ cmd: "status" }).catch(() => null); return s?.roomId === ROOM && !s.isHost && (await crownOf(hp)) === "Chromy"; }, 25000)));

// ---------------------------------------------------------------- recap in Firefox
await until(() => sh(hp, (r) => { return !!r.querySelector(".np-recap-btn"); }), 5000);
await realClick(hp, ".np-recap-btn");
const recapRoot = (fn) => hp.evaluate((src) => { const r = document.getElementById("netparty-recap")?.shadowRoot; return r ? new Function("return " + src)()(r) : null; }, fn.toString());
const drawn = await until(() => recapRoot((r) => {
  const c = r.querySelector(".np-recap-canvas");
  if (!c) return null;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let min = 765, max = 0;
  for (let i = 0; i < d.length; i += 400) { const v = d[i] + d[i + 1] + d[i + 2]; min = Math.min(min, v); max = Math.max(max, v); }
  return { w: c.width, h: c.height, range: max - min };
}), 12000);
check("Firefox draws the recap: 1080 x 1350, not blank", drawn?.w === 1080 && drawn?.h === 1350 && drawn.range > 300, JSON.stringify(drawn));
await hp.evaluate(() => {
  window.__npLinks = [];
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.localName === "a") window.__npLinks.push({ href: n.href.slice(0, 40), download: n.download, len: n.href.length }); })
    .observe(document.getElementById("netparty-recap").shadowRoot, { childList: true, subtree: true });
});
await hp.evaluate(() => [...document.getElementById("netparty-recap").shadowRoot.querySelectorAll(".card .btn")].find((b) => b.textContent === "Download").scrollIntoView());
const btnAt = (label) => hp.evaluate((l) => { const b = [...document.getElementById("netparty-recap").shadowRoot.querySelectorAll(".card .btn")].find((x) => x.textContent === l).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, label);
{
  const p = await btnAt("Download");
  await hp.mouse.click(p.x, p.y);
}
const dl = await until(() => hp.evaluate(() => window.__npLinks[0] || null), 3000);
check("Download: a PNG data: link named 'NetParty recap <date>.png'", !!dl && dl.href.startsWith("data:image/png;base64,") && dl.len > 10000 && /^NetParty recap \d{4}-\d{2}-\d{2}\.png$/.test(dl.download), JSON.stringify(dl));
{
  const p = await btnAt("Copy image");
  await hp.mouse.click(p.x, p.y);
}
const copyMsg = await until(() => recapRoot((r) => { const t = r.querySelector(".msg").textContent; return /Copied|Couldn't copy/.test(t) ? t : null; }), 5000);
check("Copy image works in Firefox", /^Copied/.test(copyMsg || ""), String(copyMsg));
await hp.keyboard.press("Escape");

// ---------------------------------------------------------------- the server saw none of it
check("no names, messages or the key in any frame", leaks(T.frames, ["Foxy", "Chromy", "Rahul", "FFMARK", "popcorn", KEY]).length === 0, JSON.stringify(leaks(T.frames, ["Foxy", "Chromy", "Rahul", "FFMARK", "popcorn", KEY])));
// (Firefox logs "ICE failed" as a page error when a voice link can't connect; the voice check above reports that)
const scriptErrors = errors.filter((e) => !/WebRTC: ICE failed/.test(e));
check("no script errors in Firefox", scriptErrors.length === 0, scriptErrors.join(" | "));
out("note: clipboard " + (readable ? "read back" : "not readable from the test page, checked the message"));
const f = summary("2.3 FIREFOX");
await H.browser.close();
await G.ctx.close();
await R.ctx.close();
T.close();
process.exit(f ? 1 : 0);
