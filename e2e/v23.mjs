// 2.3 e2e (fake Netflix; host Chirag, guests Rahul and Priya, and Arjun who joins later):
// - Invite friends: the block opens from Invite (and the compact header icon), shows the link without its key,
//   Copy link puts the full link on the clipboard, WhatsApp / Discord / Instagram copy it and open the app's own
//   start page (never with the link or key in the address), the QR code decodes (jsQR) to exactly the invite
//   link; the popup's block does the same
// - per-person voice volume (a friend's menu in the people row), on top of the friends' volume slider, kept
//   across a reload; guests get volume only, the host also gets Make host / Remove
// - host controls: Lock the party (panel and popup: invite page says locked, new people refused, people with a
//   seat come back), Remove from party (press twice; they're told, can't rejoin from that tab, no recap for
//   them), Make host (moves with the seat), leaving as host hands the party over and it carries on
// - party recap: offered when you leave, drawn on a 1080 x 1350 canvas (not blank), Download saves a PNG of
//   that size, Copy image puts a PNG on the clipboard, Esc closes it, keys in it never reach the site; the
//   Recap button shows it during the party
// - leak audit: no name, message or key in any WebSocket frame; no script errors
import fs from "node:fs";
import jsQR from "jsqr";
import { launch, until, status, people, check, summary, out, sleep, tap, leaks, keyOf, noticeText } from "./lib.mjs";
const SITE = "https://www.netflix.com/watch/12345";
const T = tap(8797, 8787);
const APPS = { whatsapp: "https://web.whatsapp.com/", discord: "https://discord.com/channels/@me", instagram: "https://www.instagram.com/direct/inbox/" };

// the apps' hosts go to a closed local port (no request to the real WhatsApp, Discord or Instagram); the same
// mapping as lib.mjs otherwise (the last --host-resolver-rules wins)
const SITES = ["www.netflix.com", "www.hotstar.com", "www.youtube.com", "static.klipy.com", "www.primevideo.com", "www.amazon.co.uk", "play.hbomax.com", "play.max.com", "www.crunchyroll.com", "static.crunchyroll.com", "www.sonyliv.com"];
const RULES = "--host-resolver-rules=" + [...SITES.map((h) => `MAP ${h}:443 127.0.0.1:8443`), ...["web.whatsapp.com", "discord.com", "www.instagram.com"].map((h) => `MAP ${h} 127.0.0.1:9`)].join(", ");
const H = await launch("pw-23h", { name: "Chirag", avatar: "🦊", extra: { serverUrl: T.url }, args: [RULES] });
const A = await launch("pw-23a", { name: "Rahul", avatar: "🐼", extra: { serverUrl: T.url }, args: [RULES] });
const B = await launch("pw-23b", { name: "Priya", avatar: "av:fox", extra: { serverUrl: T.url }, args: [RULES] });
const X = await launch("pw-23x", { name: "Arjun", avatar: "🐸", extra: { serverUrl: T.url }, args: [RULES] });
// the address a tab was opened with (an app page that can't load shows an error page; its tab keeps the address)
const openedTab = (x, want) => until(() => x.sw.evaluate((w) => chrome.tabs.query({}).then((ts) => ts.map((t) => t.pendingUrl || t.url).find((u) => u.startsWith(w)) || null), want), 5000);
const closeTabs = (x, prefix) => x.sw.evaluate((p) => chrome.tabs.query({}).then((ts) => Promise.all(ts.filter((t) => (t.pendingUrl || t.url).startsWith(p)).map((t) => chrome.tabs.remove(t.id)))), prefix);
const errors = [];
for (const x of [H, A, B, X]) {
  await x.ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://www.netflix.com" });
}
const pages = {};
for (const [x, n] of [[H, "host"], [A, "rahul"], [B, "priya"], [X, "arjun"]]) {
  const p = await x.ctx.newPage();
  pages[n] = p;
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  p.on("console", (m) => {
    if (m.type() === "error" && !/Content Security Policy|ERR_|status of 40/.test(m.text())) errors.push(n + " console: " + m.text());
    if (process.env.DEBUG) out(n + " console:", m.text().slice(0, 200));
  });
}
const { host: hp, rahul: ap, priya: bp, arjun: xp } = pages;
// runs fn(shadowRoot, arg) in the page (any function form)
const sh = (p, fn, arg) => p.evaluate(([src, a]) => { const r = document.getElementById("netparty-root")?.shadowRoot; return r ? new Function("return " + src)()(r, a) : null; }, [fn.toString(), arg]);
const tabMsg = (x, p, msg) => x.sw.evaluate(async ([u, m]) => {
  const [t] = await chrome.tabs.query({ url: u.split("#")[0].split("?")[0] + "*" });
  return chrome.tabs.sendMessage(t.id, m).catch((e) => ({ error: String(e) }));
}, [p.url(), msg]);
const sysLines = (p) => sh(p, (r) => [...r.querySelectorAll(".np-sys")].map((n) => n.textContent));
const crownOf = (p) => sh(p, (r) => { const c = r.querySelector(".np-crown"); return c && c.closest(".np-person")?.querySelector(".np-pname")?.textContent; });
const tile = (p, name) => p.locator(".np-person", { has: p.locator(".np-pname", { hasText: new RegExp("^" + name + "$") }) });

// ---------------------------------------------------------------- start + join
await hp.goto(SITE);
await hp.waitForTimeout(2000);
const created = await tabMsg(H, hp, { cmd: "create" });
const INVITE = created?.invite;
const KEY = keyOf(INVITE);
check("party created", !!KEY, JSON.stringify(created));
const ROOM = INVITE.match(/\/j\/([a-z0-9]+)/)[1];
for (const p of [ap, bp]) {
  await p.goto(INVITE);
  await until(async () => /invited you/.test((await p.textContent("h1")) || ""), 5000);
  await Promise.all([p.waitForNavigation(), p.click("a.btn")]);
}
check("Rahul and Priya joined", !!(await until(async () => (await people(hp)).length === 3 && (await people(ap)).length === 3 && (await people(bp)).length === 3, 25000)), JSON.stringify(await people(hp)));

// ---------------------------------------------------------------- invite friends (panel)
check("actions row: Invite and Recap pills", await sh(hp, (r) => !!r.querySelector(".np-actions .np-invite") && !!r.querySelector(".np-actions .np-recap-btn")));
await hp.locator(".np-invite").click();
check("Invite opens the share block", await hp.locator(".np-share-pop.np-pop-open").isVisible());
const shown = await sh(hp, (r) => r.querySelector(".np-share-link").textContent);
check("the block shows the link without its key", /^localhost:8797\/j\/[a-z0-9]+#k=••••$/.test(shown) && !shown.includes(KEY), shown);
check("four options in one block: WhatsApp, Discord, Instagram, QR code", JSON.stringify(await sh(hp, (r) => [...r.querySelectorAll(".np-share-pop .np-share-app")].map((b) => b.textContent))) === '["WhatsApp","Discord","Instagram","QR code"]');
await hp.evaluate(() => navigator.clipboard.writeText("nothing yet"));
await hp.locator(".np-share-copy").click();
check("Copy link: the full invite link (with key) on the clipboard", (await until(async () => (await hp.evaluate(() => navigator.clipboard.readText())) === INVITE, 3000)) === true);
for (const [id, url] of Object.entries(APPS)) {
  await hp.evaluate(() => navigator.clipboard.writeText("nothing yet"));
  await hp.locator(`.np-share-pop .np-share-app[data-app="${id}"]`).click();
  const opened = await openedTab(H, url.slice(0, 20));
  check(`${id}: opens ${url} (no link or key in the address)`, opened === url, String(opened));
  await hp.bringToFront();
  check(`${id}: the invite link was copied first`, (await hp.evaluate(() => navigator.clipboard.readText())) === INVITE);
  check(`${id}: says what to do`, new RegExp(`Paste it into a chat on (WhatsApp|Discord|Instagram)`).test(await sh(hp, (r) => r.querySelector(".np-share-msg").textContent)));
  await closeTabs(H, url.slice(0, 20));
}
if (!(await hp.locator(".np-share-pop.np-pop-open").isVisible())) await hp.locator(".np-invite").click();
// QR code: drawn in NetParty's own window (qr.html), never in the panel, which the site's scripts can read
const qrPageOf = (x) => x.ctx.pages().find((p) => p.url().includes("/qr.html")) || null;
const qrStored = (x) => x.sw.evaluate(() => chrome.storage.session.get(null).then((a) => Object.keys(a).filter((k) => k.startsWith("qr:"))));
const qrDecode = async (p) => {
  await p.waitForSelector("#box:not([hidden])", { timeout: 5000 }).catch(() => {});
  const px = await p.evaluate(() => { const c = document.getElementById("qr"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height); return { w: c.width, h: c.height, data: Array.from(d.data) }; });
  return jsQR(Uint8ClampedArray.from(px.data), px.w, px.h)?.data || null;
};
await hp.locator('.np-share-pop .np-share-app[data-app="qr"]').click();
const qrPage = await until(() => qrPageOf(H), 6000);
const qrRead = qrPage ? await qrDecode(qrPage) : null;
check("QR code opens in NetParty's own window and decodes to exactly the invite link", qrRead === INVITE, String(qrRead).replace(/#k=.*/, "#k=…"));
check("…and the panel says where it is", /QR code is open in a small NetParty window/.test(await sh(hp, (r) => r.querySelector(".np-share-msg").textContent)));
check("the panel draws no QR code (no canvas the site could read)", await sh(hp, (r) => !r.querySelector("canvas")));
check("the key is nowhere in the page or the panel", !(await hp.content()).includes(KEY) && (await sh(hp, (r, k) => !r.innerHTML.includes(k), KEY)));
await hp.bringToFront();
await hp.screenshot({ path: "v23-share.png" });
if (qrPage) {
  await qrPage.setViewportSize({ width: 380, height: 500 }).catch(() => {});
  await qrPage.screenshot({ path: "v23-qr.png" });
  await qrPage.close();
}
check("closing the QR window forgets the link", !!(await until(async () => (await qrStored(H)).length === 0, 5000)));
await hp.bringToFront();
if (!(await hp.locator(".np-share-pop.np-pop-open").isVisible())) await hp.locator(".np-invite").click();
await hp.keyboard.press("Escape");

// ---------------------------------------------------------------- invite friends (popup)
const hostPopup = async () => {
  const pop = await H.ctx.newPage();
  await pop.setViewportSize({ width: 320, height: 760 });
  await hp.bringToFront();
  await pop.goto(`chrome-extension://${H.sw.url().split("/")[2]}/popup.html`);
  await pop.waitForTimeout(800);
  return pop;
};
{
  const pop = await hostPopup();
  check("popup: one block with Copy invite link + WhatsApp, Discord, Instagram, QR code", (await pop.evaluate(() => document.getElementById("copy").dataset.link)) === INVITE && JSON.stringify(await pop.evaluate(() => [...document.querySelectorAll("#shareBox .share-app")].map((b) => b.textContent.trim()))) === '["WhatsApp","Discord","Instagram","QR code"]');
  await pop.click("#qrBtn");
  const px = await pop.evaluate(() => { const c = document.getElementById("qr"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height); return { w: c.width, h: c.height, data: Array.from(d.data) }; });
  check("popup: QR code decodes to the invite link", jsQR(Uint8ClampedArray.from(px.data), px.w, px.h)?.data === INVITE);
  await pop.screenshot({ path: "v23-popup-share.png" });
  await hp.evaluate(() => navigator.clipboard.writeText("nothing yet"));
  await pop.bringToFront();
  await pop.click('.share-app[data-app="discord"]');
  const opened = await openedTab(H, "https://discord.com");
  check("popup: Discord opens its start page", opened === APPS.discord, String(opened));
  await hp.bringToFront();
  check("popup: the link was copied", (await hp.evaluate(() => navigator.clipboard.readText())) === INVITE);
  await closeTabs(H, "https://discord.com");
  check("popup: host sees Lock the party, and Leave says it ends the party", !(await pop.evaluate(() => document.getElementById("lockRow").classList.contains("hidden"))) && (await pop.textContent("#leave")) === "End the party for everyone");
  await pop.close();
}

// ---------------------------------------------------------------- per-person volume
for (const p of [hp, ap, bp]) await p.locator(".np-join-voice").click();
const linkedAll = (p) => sh(p, (r) => { const t = [...r.querySelectorAll(".np-person[data-link]")]; return t.length === 2 && t.every((n) => n.dataset.link === "connected"); });
check("all three connected in voice", !!(await until(async () => (await linkedAll(hp)) && (await linkedAll(ap)) && (await linkedAll(bp)), 30000)));
await tile(hp, "Rahul").click();
check("host: Rahul's menu has volume, Make host and Remove", await hp.locator(".np-member-pop.np-pop-open .np-mm-vol").isVisible() && (await sh(hp, (r) => [...r.querySelectorAll(".np-member-pop .np-menu-btn")].map((b) => b.textContent).join("|"))) === "Make host|Remove from party");
await hp.locator(".np-member-pop .np-mm-vol").fill("40");
check("Rahul at 40% for the host only, Priya untouched", !!(await until(async () => { const l = (await status(H, hp)).levels; return l.Rahul === 0.4 && l.Priya === 1; }, 3000)), JSON.stringify((await status(H, hp)).levels));
check("the menu shows 40%", (await sh(hp, (r) => r.querySelector(".np-mm-pct").textContent)) === "40%");
await hp.screenshot({ path: "v23-member.png" });
await hp.keyboard.press("Escape");
await sh(hp, (r) => { const v = r.querySelector(".np-vol"); v.value = "0.5"; v.dispatchEvent(new Event("input")); });
check("friends' volume 50% applies on top (Rahul 20%, Priya 50%)", !!(await until(async () => { const l = (await status(H, hp)).levels; return l.Rahul === 0.2 && l.Priya === 0.5; }, 3000)), JSON.stringify((await status(H, hp)).levels));
check("others aren't affected (Rahul hears the host at 100%)", (await status(A, ap)).levels.Chirag === 1, JSON.stringify((await status(A, ap)).levels));
await tile(ap, "Priya").click();
check("guest: a friend's menu has volume only (no host controls)", (await ap.locator(".np-member-pop.np-pop-open .np-mm-vol").isVisible()) && (await sh(ap, (r) => r.querySelectorAll(".np-member-pop .np-menu-btn").length)) === 0);
await ap.keyboard.press("Escape");
await hp.reload();
check("host reload: back in voice, Rahul still at 40% (friends' slider back to 100%)", !!(await until(async () => { const s = await status(H, hp); return s.voice && s.levels?.Rahul === 0.4 && s.levels?.Priya === 1; }, 30000)), JSON.stringify((await status(H, hp)).levels));
await hp.screenshot({ path: "v23-voice.png" });

// a little activity for the recaps
const say = async (p, text) => {
  await p.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-input").focus());
  await p.keyboard.type(text);
  await p.keyboard.press("Enter");
};
for (const t of ["popcorn ready MARKER-23a", "this scene!", "no way"]) await say(hp, t);
for (const t of ["haha MARKER-23b", "plot twist"]) await say(bp, t);
await ap.locator(".np-tool.np-emo").click();
await ap.locator(".np-react-pop .np-react-btn").first().click();
await ap.keyboard.press("Escape");
check("recap totals count every line once (5 messages, 1 reaction, 3 people)", !!(await until(async () => { const r = (await status(B, bp)).recap; return r && r.msgs === 5 && r.reacts === 1 && r.people === 3; }, 8000)), JSON.stringify((await status(B, bp)).recap));
await bp.reload();
check("…and after a reload the history isn't counted twice", !!(await until(async () => { const r = (await status(B, bp)).recap; return r && r.msgs === 5 && r.reacts === 1; }, 15000)), JSON.stringify((await status(B, bp)).recap));
check("the recap knows what's playing", (await status(H, hp)).recap?.title === "Fake Movie", JSON.stringify((await status(H, hp)).recap));

// ---------------------------------------------------------------- lock
await hp.locator(".np-tool-set").click();
check("host: Settings has the party switches (both off)", (await hp.locator(".np-set-host").isVisible()) && JSON.stringify(await sh(hp, (r) => [...r.querySelectorAll("[data-host-set]")].map((b) => b.dataset.hostSet + "=" + b.getAttribute("aria-checked")))) === '["hostOnly=false","locked=false"]');
await hp.locator('[data-host-set="locked"]').click();
check("locking shows on the guests ('· locked')", !!(await until(async () => /· locked/.test(await sh(ap, (r) => r.querySelector(".np-meta").textContent)), 5000)));
check("the switch keeps the keyboard focus", await sh(hp, (r) => r.activeElement?.dataset?.hostSet === "locked"));
await hp.keyboard.press("Escape");
check("Esc closes Settings", !(await hp.locator(".np-set-pop.np-pop-open").isVisible()));
await ap.locator(".np-tool-set").click();
check("guests don't get the party switches", !(await ap.locator(".np-set-host").isVisible()));
await ap.keyboard.press("Escape");
await xp.goto(INVITE);
check("invite page of a locked party says so (no join button)", /This party is locked/.test(await xp.textContent("h1")) && (await xp.locator("a.btn").count()) === 0);
await xp.goto(SITE);
await xp.waitForTimeout(2000);
const refused = await tabMsg(X, xp, { cmd: "join", roomId: ROOM, key: KEY });
check("a new person can't join a locked party", /This party is locked/.test(refused?.error || ""), JSON.stringify(refused));
await ap.reload();
check("someone with a seat comes back while locked (reload)", !!(await until(async () => (await status(A, ap)).roomId === ROOM && (await people(ap)).length === 3, 20000)));
{
  const pop = await hostPopup();
  check("popup shows the lock as on", await pop.evaluate(() => document.getElementById("lockParty").checked));
  await pop.click("#lockParty");
  await pop.waitForTimeout(500);
  await pop.close();
}
check("unlocked from the popup (guests see it)", !!(await until(async () => !/locked/.test(await sh(ap, (r) => r.querySelector(".np-meta").textContent)), 5000)));
const joined = await tabMsg(X, xp, { cmd: "join", roomId: ROOM, key: KEY });
check("after unlocking, Arjun can join", !joined?.error && !!(await until(async () => (await people(hp)).length === 4, 20000)), JSON.stringify(joined));
// a guest shares too; his QR window goes away with the party
await xp.bringToFront();
await xp.locator(".np-invite").click();
await xp.locator('.np-share-pop .np-share-app[data-app="qr"]').click();
const xq = await until(() => qrPageOf(X), 6000);
const xRead = xq ? await qrDecode(xq) : null;
check("guest: QR code of the same invite link", xRead === INVITE);
await xp.bringToFront();
await xp.keyboard.press("Escape");
await hp.bringToFront();

// ---------------------------------------------------------------- remove
await tile(hp, "Arjun").click();
const rm = hp.locator(".np-member-pop .np-menu-btn.np-danger");
await rm.click();
check("Remove asks once more", (await rm.textContent()) === "Press again to remove Arjun" && (await people(hp)).length === 4);
await rm.click();
check("Arjun is told he was removed", !!(await until(async () => /The host removed you from the party/.test(await noticeText(xp)), 6000)), await noticeText(xp));
check("Arjun is out of the party (his tab)", !(await status(X, xp)).roomId);
check("…his QR window closed and its link is forgotten", !!(await until(async () => !qrPageOf(X) && (await qrStored(X)).length === 0, 6000)));
check("everyone else: 3 people, 'Arjun was removed from the party'", !!(await until(async () => (await people(hp)).length === 3 && (await people(bp)).length === 3 && (await sysLines(bp)).includes("Arjun was removed from the party"), 6000)), JSON.stringify((await sysLines(bp)).slice(-3)));
check("no 'Arjun left' line as well", !(await sysLines(bp)).includes("Arjun left"));
const again = await tabMsg(X, xp, { cmd: "join", roomId: ROOM, key: KEY });
check("Arjun's tab can't rejoin", /removed you/.test(again?.error || ""), JSON.stringify(again));
check("no recap offered to someone who was removed", !(await xp.evaluate(() => !!document.getElementById("netparty-recap")?.shadowRoot?.querySelector(".offer"))));

// ---------------------------------------------------------------- make host, and leaving as host
await tile(hp, "Rahul").click();
await hp.locator(".np-member-pop .np-menu-btn", { hasText: "Make host" }).click();
check("Rahul is the host now (everyone)", !!(await until(async () => (await crownOf(hp)) === "Rahul" && (await crownOf(bp)) === "Rahul" && (await crownOf(ap)) === "You", 6000)));
check("…with a line in the chat", (await sysLines(bp)).includes("Rahul is the host now"));
await hp.reload();
check("the old host reloading stays a guest", !!(await until(async () => (await status(H, hp)).roomId === ROOM && (await crownOf(hp)) === "Rahul", 20000)));
check("…and doesn't see host switches; Rahul does", !(await status(H, hp)).isHost && (await status(A, ap)).isHost);
await ap.locator(".np-link-btn").click();
check("leaving as host: hand over or end", (await ap.locator(".np-leave-pop.np-pop-open").isVisible()) && JSON.stringify(await sh(ap, (r) => [...r.querySelectorAll(".np-leave-pop .np-menu-btn")].map((b) => b.lastChild.textContent).sort())) === JSON.stringify(["End the party for everyone", "Make Chirag host and leave", "Make Priya host and leave"]));
await ap.screenshot({ path: "v23-leave.png" });
await ap.locator(".np-leave-pop .np-menu-btn", { hasText: "Make Priya host" }).click();
check("Rahul is out, told who the host is", !!(await until(async () => !(await status(A, ap)).roomId && /Priya is the host now/.test(await noticeText(ap)), 8000)), await noticeText(ap));
check("the party carries on with Priya as host", !!(await until(async () => (await crownOf(hp)) === "Priya" && (await crownOf(bp)) === "You" && (await people(hp)).length === 2, 8000)));
const vids = async () => JSON.stringify(await Promise.all([hp, bp].map((p) => p.evaluate(() => { const v = document.querySelector("video"); return { paused: v.paused, t: Math.round(v.currentTime * 10) / 10 }; }))));
out("videos after the hand-over (Chirag, Priya):", await vids(), "| hold:", await sh(bp, (r) => r.querySelector(".np-hold")?.hidden ? "" : r.querySelector(".np-hold-txt")?.textContent));
check("playback still syncs after the hand-over (Priya plays, then pauses)", await (async () => {
  await bp.evaluate(() => document.querySelector("video").play());
  const played = await until(() => hp.evaluate(() => !document.querySelector("video").paused), 6000);
  await sleep(1500);
  await bp.evaluate(() => document.querySelector("video").pause());
  const paused = await until(() => hp.evaluate(() => document.querySelector("video").paused), 6000);
  return !!played && !!paused;
})(), await vids());

// ---------------------------------------------------------------- recap
const recapRoot = (p, fn) => p.evaluate((src) => { const r = document.getElementById("netparty-recap")?.shadowRoot; return r ? new Function("return " + src)()(r) : null; }, fn.toString());
check("leaving offers a recap", !!(await until(() => recapRoot(ap, (r) => { return !!r.querySelector(".offer.s"); }), 5000)));
await ap.locator("#netparty-recap .offer .btn").click();
const drawn = await until(() => recapRoot(ap, (r) => {
  const c = r.querySelector(".np-recap-canvas");
  if (!c) return null;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 400) { const v = d[i] + d[i + 1] + d[i + 2]; min = Math.min(min, v); max = Math.max(max, v); }
  return { w: c.width, h: c.height, range: max - min };
}), 10000);
check("the recap is drawn: 1080 x 1350, not blank", drawn?.w === 1080 && drawn?.h === 1350 && drawn.range > 300, JSON.stringify(drawn));
await ap.screenshot({ path: "v23-recap-view.png" });
const before = await ap.evaluate(() => window.__hotkeys);
await ap.keyboard.press(" ");
check("keys in the recap never reach the site", (await ap.evaluate(() => window.__hotkeys)) === before);
// Download: a link with download="NetParty recap <date>.png" and the PNG as a data: URL, clicked right away. (The
// fake sites' self-signed HTTPS makes Chromium refuse every download on them, so the link is caught as it's
// added and checked here instead; on a plain http page the same kind of link downloads, see the README.)
await ap.evaluate(() => {
  window.__npLinks = [];
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.localName === "a") window.__npLinks.push({ href: n.href, download: n.download }); })
    .observe(document.getElementById("netparty-recap").shadowRoot, { childList: true, subtree: true });
});
await ap.locator("#netparty-recap .card .btn", { hasText: "Download" }).click();
const link = await until(() => ap.evaluate(() => window.__npLinks[0] || null), 3000);
const png = link && /^data:image\/png;base64,/.test(link.href) ? Buffer.from(link.href.split(",")[1], "base64") : Buffer.alloc(0);
if (png.length) fs.writeFileSync("v23-recap.png", png);
const pw = png.length > 24 ? png.readUInt32BE(16) : 0, ph = png.length > 24 ? png.readUInt32BE(20) : 0;
check("Download: a PNG link (1080 x 1350) named 'NetParty recap <date>.png'", !!link && /^NetParty recap \d{4}-\d{2}-\d{2}\.png$/.test(link.download) && png.subarray(1, 4).toString() === "PNG" && pw === 1080 && ph === 1350, `${link?.download} ${pw}x${ph}`);
check("…and the viewer says so", (await recapRoot(ap, (r) => r.querySelector(".msg").textContent)) === "Saved to your downloads.");
await ap.locator("#netparty-recap .card .btn", { hasText: "Copy image" }).click();
const clip = await until(() => ap.evaluate(async () => { try { const t = (await navigator.clipboard.read()).flatMap((i) => i.types); return t.includes("image/png") ? t : null; } catch { return null; } }), 5000);
check("Copy image puts a PNG on the clipboard", Array.isArray(clip) && clip.includes("image/png"), JSON.stringify(clip));
await ap.keyboard.press("Escape");
check("Esc closes the recap", !!(await until(() => recapRoot(ap, (r) => { return !r.querySelector(".bd"); }), 3000)));
await bp.locator(".np-recap-btn").click();
check("Recap button during the party shows it", !!(await until(() => recapRoot(bp, (r) => { return !!r.querySelector(".np-recap-canvas"); }), 10000)));
await bp.keyboard.press("Escape");

// ---------------------------------------------------------------- the server saw none of it
const secret = ["Chirag", "Rahul", "Priya", "Arjun", "MARKER-23", "popcorn", "plot twist", KEY];
check("no WebSocket frame contains names, messages or the key", leaks(T.frames, secret).length === 0, JSON.stringify(leaks(T.frames, secret)));
check("no plaintext fields in any frame", !T.frames.some((f) => /"(name|text|avatar|byName|e|s)":/.test(f.text)));
check("no script errors on the pages", errors.length === 0, errors.join(" | "));
const f = summary("2.3");
T.close();
for (const x of [H, A, B, X]) await x.ctx.close();
process.exit(f ? 1 : 0);
