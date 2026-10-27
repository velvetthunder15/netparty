// NetParty in real Firefox ESR: two Firefox profiles with the AMO build installed, fake Netflix
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// (or SITE=...), local party server behind a TLS recording proxy.
// IDLE=<ms> sets extensions.background.idle.timeout in both browsers; QUIET=<s> idles that long mid-test.
import { launchFF, extPage, tapTLS } from "./fflib.mjs";
import { shadow, until, people, check, summary, out, sleep, leaks, keyOf } from "/workspace/work/e2e/lib.mjs";
const SITE = process.env.SITE || "https://www.netflix.com/watch/12345";
const IDLE = process.env.IDLE ? Number(process.env.IDLE) : null;
const QUIET = Number(process.env.QUIET || 0);
const T = tapTLS(8792, 8787);
const prefs = IDLE ? { "extensions.background.idle.timeout": IDLE } : {};
const UH = "aaaaaaaa-0000-4000-8000-000000000001", UG = "aaaaaaaa-0000-4000-8000-000000000002";
const H = await launchFF("/tmp/ff-host", { uuid: UH, prefs });
const G = await launchFF("/tmp/ff-guest", { uuid: UG, prefs });
out("Firefox", await H.browser.version(), IDLE ? `idle timeout ${IDLE} ms` : "default idle timeout");
const he = await extPage(H), ge = await extPage(G);
const perms = await he.evaluate(() => chrome.permissions.getAll());
out("granted:", JSON.stringify(perms));
check("Firefox granted the declared data collection at install", JSON.stringify((perms.data_collection || []).slice().sort()) === JSON.stringify(["browsingActivity", "personalCommunications", "websiteActivity", "websiteContent"]), JSON.stringify(perms.data_collection));
const WANT_VER = JSON.parse((await import("node:fs")).readFileSync(new URL("../../extension/manifest.json", "file:///workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/e2e/firefox/"), "utf8")).version;
check("add-on version matches extension/manifest.json (" + WANT_VER + ")", (await he.evaluate(() => chrome.runtime.getManifest().version)) === WANT_VER);
await he.evaluate((u) => chrome.storage.sync.set({ serverUrl: u, name: "Chirag", avatar: "🦊" }), T.url);
await ge.evaluate((u) => chrome.storage.sync.set({ serverUrl: u, name: "Rahul", avatar: "🐼" }), T.url);
const errors = [];
const hp = await H.browser.newPage(), gp = await G.browser.newPage();
for (const [p, n] of [[hp, "host"], [gp, "guest"]]) {
  p.on("pageerror", (e) => /favicon\.ico/.test(String(e.message || e)) ? out(n + " (browser favicon request blocked by the invite page CSP, ignored)") : (errors.push(n + ": " + String(e.message || e)), out(n + " pageerror:", String(e.message || e))));
  if (process.env.DEBUG) p.on("console", (m) => out(n + " console:", m.text().slice(0, 200)));
}
// reload, retried once if the local test proxy drops the connection (harness, not the add-on); logged
const reload = async (p) => { try { await p.reload({ waitUntil: "domcontentloaded" }); } catch (e) { out("reload retry after:", String(e.message).split("\n")[0]); await sleep(500); await p.goto(p.url(), { waitUntil: "domcontentloaded" }); } };
const go = (p, u) => p.goto(u, { waitUntil: "domcontentloaded", timeout: 20000 });
// a WebSocket "open" per browser = a (re)start of the background's socket
const opens = (uuid) => T.frames.filter((f) => f.dir === "open" && f.origin === `moz-extension://${uuid}`).length;
const rect = (p, sel) => shadow(p, (r, a) => { const e = r.querySelector(a); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel);
const clickIn = async (p, sel) => { const c = await rect(p, sel); if (!c) throw new Error("no " + sel); await p.mouse.click(c.x, c.y); };
const hoverIn = async (p, sel) => { const c = await rect(p, sel); if (!c) throw new Error("no " + sel); await p.mouse.move(c.x, c.y); };
const bubbles = (p) => shadow(p, (r) => { return [...r.querySelectorAll(".np-bubble")].map((n) => n.firstChild.textContent); });
const vid = (p, f) => p.evaluate(f);

await go(hp, SITE);
await sleep(2500);
check("content script runs in Firefox (panel root injected)", !!(await hp.evaluate(() => !!document.getElementById("netparty-root"))));
await hp.bringToFront();
const created = await he.evaluate(async (site) => {
  const tabs = await chrome.tabs.query({});
  const t = tabs.find((t) => (t.url || "").startsWith(site.split("?")[0].replace(/\/watch.*/, "")));
  return chrome.tabs.sendMessage(t.id, { cmd: "create" });
}, SITE);
out("create ->", JSON.stringify(created).replace(/#k=[\w-]+/, "#k=<key>"));
const KEY = keyOf(created?.invite);
check("party created, invite link has the key in its #fragment", !!KEY, JSON.stringify(created));
if (!KEY) { await H.browser.close(); await G.browser.close(); T.close(); process.exit(1); }
const ROOM = created.invite.match(/\/j\/([a-z0-9]+)/)[1];

// guest opens the invite link like a friend would
await go(gp, created.invite);
const h1 = await until(async () => { const t = (await gp.evaluate(() => document.querySelector("h1")?.textContent || "")).trim(); return /^Chirag invited you/.test(t) && t; }, 8000);
check("invite page (in Firefox): 'Chirag invited you'", !!h1, String(h1));
const href = await gp.evaluate(() => document.querySelector("a.btn")?.href);
check("Join link = watch page + key in its #fragment", !!href && href.endsWith(`npParty=${ROOM}#npKey=${KEY}`), String(href));
await Promise.all([gp.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}), gp.evaluate(() => document.querySelector("a.btn").click())]);
check("guest joined via the invite link", !!(await until(async () => (await people(gp))?.length >= 2, 20000)), JSON.stringify(await people(gp)));
check("key removed from the guest's address bar", !gp.url().includes("npKey") && !gp.url().includes(KEY), gp.url());
check("guest sees both names", JSON.stringify(await people(gp)) === JSON.stringify(["Chirag", "You"]), JSON.stringify(await people(gp)));
check("host sees 'Rahul joined'", !!(await until(() => shadow(hp, (r) => { return [...r.querySelectorAll(".np-sys")].some((n) => n.textContent === "Rahul joined"); }), 6000)));
check("the site's scripts can't find the key in page storage", !(await gp.evaluate((k) => JSON.stringify({ ...sessionStorage, ...localStorage }).includes(k), KEY)));

// encrypted chat both ways
await gp.bringToFront();
await clickIn(gp, ".np-input");
await gp.keyboard.type("hello from rahul FFMARK-1");
await gp.keyboard.press("Enter");
check("chat guest → host (typed + Enter)", !!(await until(async () => (await bubbles(hp))?.includes("hello from rahul FFMARK-1"))), JSON.stringify(await bubbles(hp)));
check("site hotkeys not triggered while typing", (await gp.evaluate(() => window.__hotkeys)) === 0, String(await gp.evaluate(() => window.__hotkeys)));
await hp.bringToFront();
await clickIn(hp, ".np-input");
await hp.keyboard.type("hey rahul, send button FFMARK-2");
await clickIn(hp, ".np-send");
check("chat host → guest (Send button)", !!(await until(async () => (await bubbles(gp))?.includes("hey rahul, send button FFMARK-2"))), JSON.stringify(await bubbles(gp)));

// playback sync (goes through page.js in the page's main world on Netflix/JioHotstar)
const hasBridge = await hp.evaluate(() => !!window.__netpartyBridge);
check("page.js bridge running in the page", hasBridge || /youtube|primevideo/.test(SITE), String(hasBridge));
await vid(hp, () => (document.querySelector("#dv-web-player video") || document.querySelector("video")).pause());
check("host pause → guest pauses", !!(await until(() => gp.evaluate(() => (document.querySelector("#dv-web-player video") || document.querySelector("video")).paused), 6000)));
await vid(hp, () => { const v = (document.querySelector("#dv-web-player video") || document.querySelector("video")); v.currentTime = 60; v.play(); });
await sleep(3000);
const ht = await vid(hp, () => (document.querySelector("#dv-web-player video") || document.querySelector("video")).currentTime), gt = await vid(gp, () => (document.querySelector("#dv-web-player video") || document.querySelector("video")).currentTime);
const gPlaying = !(await vid(gp, () => (document.querySelector("#dv-web-player video") || document.querySelector("video")).paused));
check("host seek to 60 s + play → guest follows", gPlaying && Math.abs(ht - gt) < 1.5, `host ${ht.toFixed(1)} guest ${gt.toFixed(1)} playing ${gPlaying}`);
await vid(gp, () => { const v = (document.querySelector("#dv-web-player video") || document.querySelector("video")); v.currentTime = 30; });
await sleep(2500);
const ht2 = await vid(hp, () => (document.querySelector("#dv-web-player video") || document.querySelector("video")).currentTime), gt2 = await vid(gp, () => (document.querySelector("#dv-web-player video") || document.querySelector("video")).currentTime);
check("guest seek to 30 s → host follows (guest controls allowed)", Math.abs(ht2 - gt2) < 1.5 && ht2 < 45, `host ${ht2.toFixed(1)} guest ${gt2.toFixed(1)}`);

// reactions: hover 🎉, click one, it floats on the other screen
await hp.bringToFront();
await hoverIn(hp, '.np-tool[aria-label="Reactions"]');
const trayOpen = await until(() => shadow(hp, (r) => { const p = r.querySelector(".np-react-pop"); return !!p && p.getBoundingClientRect().height > 0 && getComputedStyle(p).visibility !== "hidden" && !p.hidden; }), 2000, 50);
check("hovering 🎉 opens the reaction tray", !!trayOpen);
const tray = await shadow(hp, (r) => { return [...r.querySelectorAll(".np-react-btn")].map((b) => b.textContent).join(" "); });
check("tray has the 5 default reactions", tray === "😂 😭 💀 🥰 😱", tray);
await hoverIn(hp, '.np-react-btn[data-emoji="😂"]');
await clickIn(hp, '.np-react-btn[data-emoji="😂"]');
const fly = await until(() => shadow(gp, (r) => { const f = r.querySelector(".np-fly"); return f && f.textContent === "😂" ? f.getBoundingClientRect().top : null; }), 4000, 50);
check("reaction floats on the guest's screen", fly !== null && fly !== undefined);
await sleep(500);
const fly2 = await shadow(gp, (r) => { const f = r.querySelector(".np-fly"); return f ? f.getBoundingClientRect().top : null; });
check("…and rises (CSS animation runs)", fly2 !== null && fly2 < fly - 20, `${fly} -> ${fly2}`);

// copy invite from the panel (real click), paste it into the page: the clipboard works
await hp.mouse.move(5, 5);
await sleep(300);
const copyBtn = await shadow(hp, (r) => { return [...r.querySelectorAll(".np-pill")].findIndex((b) => /Copy invite/.test(b.textContent)); });
if (copyBtn >= 0) {
  const c = await shadow(hp, (r, a) => { const b = [...r.querySelectorAll(".np-pill")][a].getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, copyBtn);
  await hp.mouse.click(c.x, c.y);
  const copied = await until(() => shadow(hp, (r) => { return [...r.querySelectorAll(".np-pill")].some((b) => b.textContent === "Copied!"); }), 2000, 50);
  await hp.evaluate(() => { const t = document.createElement("textarea"); t.id = "__paste"; t.style.cssText = "position:fixed;top:0;left:0;width:200px;height:40px;z-index:2147483647"; document.body.append(t); t.focus(); });
  await hp.keyboard.down("Control"); await hp.keyboard.press("v"); await hp.keyboard.up("Control");
  await sleep(300);
  const pasted = await hp.evaluate(() => { const t = document.getElementById("__paste"); const v = t.value; t.remove(); return v; });
  check("panel 'Copy invite' puts the invite link (with key) on the clipboard", !!copied && pasted === created.invite, `copied=${!!copied} pasted=${pasted.replace(/#k=.*/, "#k=…")}`);
} else check("panel has a Copy invite button", false);

// popup (popup.html in a tab, with the host's watch tab active): in-party view
const pop = await H.browser.newPage();
await pop.setViewport({ width: 320, height: 600 });
await hp.bringToFront();
await pop.goto(`${H.base}/popup.html`, { waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
const pv = await until(() => pop.evaluate(() => !document.getElementById("vParty").classList.contains("hidden") && { code: document.getElementById("partyCode").textContent, who: document.getElementById("who").textContent, link: document.getElementById("copy").dataset.link, host: !document.getElementById("hostRow").classList.contains("hidden") }).catch(() => null), 6000);
check("popup shows the party (code, who's watching, host controls)", !!pv && pv.code === ROOM && /2 watching/.test(pv.who) && pv.host, JSON.stringify(pv && { ...pv, link: undefined }));
check("popup's Copy invite link includes the key", pv?.link === created.invite);
const avatarShown = await pop.evaluate(() => document.getElementById("avatarBtn")?.textContent);
check("popup shows your picture", avatarShown === "🦊", String(avatarShown));
await pop.evaluate(() => { document.getElementById("avatarBtn").click(); });
await sleep(200);
const picked = await pop.evaluate(() => { const b = document.querySelector('.avatar-opt[aria-label="Use 🐙"]'); if (!b) return false; b.click(); return true; });
const pics = (p) => shadow(p, (r) => { return [...r.querySelectorAll(".np-person")].map((n) => n.querySelector(".np-pname")?.textContent + "=" + (n.querySelector(".np-avatar-pic")?.textContent || "")); });
check("popup avatar change reaches the friend live", picked && !!(await until(async () => (await pics(gp))?.includes("Chirag=🐙"), 6000)), JSON.stringify(await pics(gp)));
await pop.close();

// voice (fake microphone; peer to peer over loopback)
const linked = (p) => shadow(p, (r) => { return [...r.querySelectorAll(".np-person[data-link]")].map((n) => n.dataset.link).join(); });
await shadow(gp, (r) => { r.querySelector(".np-join-voice")?.click(); });
await sleep(700);
await shadow(hp, (r) => { r.querySelector(".np-join-voice")?.click(); });
const vOk = await until(async () => (await linked(hp)) === "connected" && (await linked(gp)) === "connected", 25000);
check("voice: WebRTC connects peer to peer (content-script RTCPeerConnection + getUserMedia)", !!vOk, JSON.stringify([await linked(hp), await linked(gp)]));
const sig = T.frames.filter((f) => f.dir === "up" && f.text.includes('"type":"signal"'));
check("voice signaling went through the server as ciphertext only", sig.length >= 2 && sig.every((f) => Object.keys(JSON.parse(f.text).data).sort().join() === "ct,to"), String(sig.length));
await shadow(hp, (r) => { r.querySelector(".np-hang")?.click(); });
await shadow(gp, (r) => { r.querySelector(".np-hang")?.click(); });

// background survives being left alone (event page idle timeout)
if (QUIET) {
  const before = [opens(UH), opens(UG)];
  out(`idling ${QUIET}s with no user activity…`);
  await sleep(QUIET * 1000);
  const after = [opens(UH), opens(UG)];
  check(`no socket restarts during ${QUIET}s idle${IDLE ? ` (idle timeout ${IDLE} ms)` : ""}`, after[0] === before[0] && after[1] === before[1], `opens before ${before} after ${after}`);
  await hp.bringToFront();
  await clickIn(hp, ".np-input");
  await hp.keyboard.type("after the quiet FFMARK-3");
  await hp.keyboard.press("Enter");
  check("chat still flows after the idle period", !!(await until(async () => (await bubbles(gp))?.includes("after the quiet FFMARK-3"), 15000)), JSON.stringify((await bubbles(gp))?.slice(-2)));
  await vid(hp, () => (document.querySelector("#dv-web-player video") || document.querySelector("video")).pause());
  check("sync still flows after the idle period", !!(await until(() => gp.evaluate(() => (document.querySelector("#dv-web-player video") || document.querySelector("video")).paused), 8000)));
  await vid(hp, () => (document.querySelector("#dv-web-player video") || document.querySelector("video")).play());
  await sleep(1000);
}

// reloads: seats, host role and decrypted history survive (room key in storage.session)
const shot = (p) => shadow(p, (r) => { return { people: [...r.querySelectorAll(".np-pname")].map((n) => n.textContent), msgs: [...r.querySelectorAll(".np-bubble")].map((n) => n.firstChild.textContent), authors: [...r.querySelectorAll(".np-author")].map((n) => n.textContent) }; });
const histOk = (s) => s && s.msgs.includes("hello from rahul FFMARK-1") && s.msgs.includes("hey rahul, send button FFMARK-2") && s.people.length === 2;
await reload(gp);
const gs = await until(async () => { const s = await shot(gp); return histOk(s) && s; }, 20000);
check("guest reload: rejoined, history decrypted again (key from storage.session)", !!gs && gs.authors.includes("Chirag"), JSON.stringify(gs || (await shot(gp))));
await reload(hp);
const hs = await until(async () => { const s = await shot(hp); return histOk(s) && s; }, 20000);
check("host reload: rejoined, history decrypted again", !!hs, JSON.stringify(hs || (await shot(hp))));
const crownName = await hp.evaluate(() => { const r = document.getElementById("netparty-root")?.shadowRoot; const c = r?.querySelector(".np-crown"); return c && c.closest(".np-person")?.querySelector(".np-pname")?.textContent; });
check("host still host after reload", crownName === "You", String(crownName));
await sleep(3000);
await vid(hp, () => (document.querySelector("#dv-web-player video") || document.querySelector("video")).pause());
check("sync after reloads (guest pauses)", !!(await until(() => gp.evaluate(() => (document.querySelector("#dv-web-player video") || document.querySelector("video")).paused), 6000)));
const stored = await he.evaluate(() => chrome.storage.session.get(null));
check("room key kept in storage.session (memory only) for the host tab", Object.entries(stored).some(([k, v]) => k.startsWith("rk:") && k.endsWith(":" + ROOM) && v === KEY), JSON.stringify(Object.keys(stored)));

// leave: host ends the party; key removed
await hp.bringToFront();
const left = await he.evaluate(async () => { const tabs = await chrome.tabs.query({}); const t = tabs.find((t) => /netflix|hotstar|youtube|primevideo/.test(t.url || "")); return chrome.tabs.sendMessage(t.id, { cmd: "leave" }); });
const gStatus = () => ge.evaluate(async () => { const tabs = await chrome.tabs.query({}); const t = tabs.find((t) => /netflix|hotstar|youtube|primevideo/.test(t.url || "")); return chrome.tabs.sendMessage(t.id, { cmd: "status" }); });
const gEnded = await until(async () => { const s = await gStatus(); return !s.roomId && s; }, 8000);
const notice = await gp.evaluate(() => document.getElementById("netparty-notice")?.shadowRoot?.querySelector(".n")?.textContent || "");
check("host leaving (popup Leave) ends the party; guest told it ended", !!gEnded && /ended/.test(notice), JSON.stringify(left) + " " + notice);
const ended = await fetch(T.url.replace(/^wss/, "https") + "/j/" + ROOM, { dispatcher: undefined }).then((r) => r.status).catch((e) => String(e));
check("invite link now says ended (404)", ended === 404, String(ended));
const stored2 = await until(async () => { const s = await he.evaluate(() => chrome.storage.session.get(null)); return !Object.keys(s).some((k) => k.endsWith(":" + ROOM)) && s; }, 4000);
check("room key deleted from storage.session after leaving", !!stored2);

// the server saw ciphertext only
const secret = ["Chirag", "Rahul", "hello from rahul", "FFMARK", "send button", KEY];
check("no WebSocket frame contains names, messages or the key", leaks(T.frames, secret).length === 0, JSON.stringify(leaks(T.frames, secret)));
check("no plaintext fields in any frame", !T.frames.some((f) => /"(name|text|avatar|byName)":/.test(f.text)));
check("no script errors on the pages", errors.length === 0, errors.join(" | "));
out("socket opens per browser (host, guest):", opens(UH), opens(UG));
const f = summary("FIREFOX");
T.close();
await H.browser.close();
await G.browser.close();
process.exit(f ? 1 : 0);
