// 2.1 chat e2e (fake Netflix): reply to a message, reactions on messages, emoji search.
// Two browsers (host Chirag, guest Rahul, guest in light mode), a scripted third member ("Bottie",
// a plain WebSocket client that sends a GIF line the way 2.0.x does, without a message id, and
// decrypts everything it gets), and a 2.0.2 browser (the extension at git HEAD~ 2.0.2, unpacked to
// /tmp/np-old) to check old clients still read replies as text and never show reactions as lines.
// Everything goes through a recording proxy; at the end no WebSocket frame may contain a quote
// snippet, a reaction emoji, a name or a message.
import { execSync } from "node:child_process";
import fs from "node:fs";
import { launch, shadow, until, people, check, summary, out, sleep, tap, leaks, keyOf } from "./lib.mjs";
import { WebSocket } from "/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/server/node_modules/ws/wrapper.mjs";
const REPO = "/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty";
const SITE = "https://www.netflix.com/watch/12345";
const T = tap(8791, 8787);

// the 2.0.2 extension, straight from git (the last 2.0.x commit)
const OLD = "/tmp/np-old/extension";
const oldRev = process.env.OLD_REV || "52ed769";
fs.rmSync("/tmp/np-old", { recursive: true, force: true });
fs.mkdirSync("/tmp/np-old");
execSync(`git -C ${REPO} archive ${oldRev} extension | tar -x -C /tmp/np-old`);
const oldVer = JSON.parse(fs.readFileSync(OLD + "/manifest.json", "utf8")).version;

const H = await launch("/tmp/pw-c2h", { name: "Chirag", avatar: "🦊", extra: { serverUrl: T.url, theme: "dark" } });
const G = await launch("/tmp/pw-c2g", { name: "Rahul", avatar: "🐼", extra: { serverUrl: T.url, theme: "light" } });
const O = await launch("/tmp/pw-c2o", { name: "Oldie", avatar: "🐢", extra: { serverUrl: T.url }, ext: OLD });
const hp = await H.ctx.newPage(), gp = await G.ctx.newPage(), op = await O.ctx.newPage();
const errors = [];
for (const [p, n] of [[hp, "host"], [gp, "guest"], [op, "old"]]) {
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  p.on("console", (m) => {
    if (m.type() === "error" && !/Content Security Policy|ERR_|status of 40/.test(m.text())) errors.push(n + " console: " + m.text());
  });
}
await hp.goto(SITE);
await hp.waitForTimeout(2000);
const created = await H.sw.evaluate(async (url) => {
  const [t] = await chrome.tabs.query({ url: url + "*" });
  return chrome.tabs.sendMessage(t.id, { cmd: "create" });
}, SITE);
check("party created", !!created?.invite, JSON.stringify(created));
const KEY = keyOf(created.invite);
const ROOM = created.invite.match(/\/j\/([a-z0-9]+)/)[1];
for (const p of [gp, op]) {
  await p.goto(created.invite);
  await Promise.all([p.waitForNavigation(), p.click("a.btn")]);
}
check("guest + 2.0.x guest joined", !!(await until(async () => (await people(hp)).length === 3 && (await people(gp)).length === 3 && (await people(op)).length === 3, 25000)), `old client ${oldVer}`);

// ---- a scripted member: joins over the WebSocket with the room key, like the extension
const enc = new TextEncoder();
const aad = (kind, pid) => enc.encode(`netparty/e2ee/v1|${ROOM}|${kind}|${pid}`);
const cKey = await crypto.subtle.importKey("raw", Buffer.from(KEY, "base64url"), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
async function seal(kind, pid, obj) {
  const json = enc.encode(JSON.stringify(obj));
  const pt = new Uint8Array(Math.max(64, Math.ceil(json.length / 64) * 64)).fill(0x20);
  pt.set(json);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(kind, pid) }, cKey, pt));
  return Buffer.concat([Buffer.from([1]), iv, ct]).toString("base64url");
}
async function openCt(kind, pid, s) {
  try {
    const b = Buffer.from(s, "base64url");
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(1, 13), additionalData: aad(kind, pid) }, cKey, b.subarray(13))));
  } catch {
    return null;
  }
}
const bot = await (async () => {
  const ws = new WebSocket(T.url);
  const got = []; // decrypted chat lines { from, ct, p }
  let seq = 0;
  const replies = new Map();
  ws.on("message", async (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "reply") return replies.get(m.reqId)?.(m);
    if (m.type === "chat") got.push({ from: m.data.from, ct: m.data.ct, p: await openCt("chat", m.data.from, m.data.ct) });
  });
  await new Promise((r) => ws.once("open", r));
  const req = (type, data) => {
    const reqId = ++seq;
    ws.send(JSON.stringify({ type, reqId, data }));
    return new Promise((res, rej) => replies.set(reqId, (m) => (m.error ? rej(new Error(m.error)) : res(m.data))));
  };
  const snap = await req("join", { e2ee: 1, roomId: ROOM, cid: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex") });
  const pid = snap.you;
  await req("profile", { ct: await seal("profile", pid, { name: "Bottie", avatar: "🤖" }) });
  return { pid, got, req, say: async (obj) => req("chat", { ct: await seal("chat", pid, obj) }), close: () => ws.close() };
})();
check("scripted member joined", !!(await until(async () => (await people(hp)).length === 4, 10000)));

// ---- helpers
// run fn(shadowRoot, arg) in the page (any arrow function)
const sh = (p, fn, arg) => p.evaluate(([src, a]) => { const r = document.getElementById("netparty-root")?.shadowRoot; return r ? new Function("return " + src)()(r, a) : null; }, [fn.toString(), arg]);
const send = async (p, t) => { await p.locator(".np-input").click(); await p.keyboard.type(t); await p.keyboard.press("Enter"); };
const lines = (p) => sh(p, (r) => {
  return [...r.querySelectorAll(".np-msg")].map((m) => {
    const b = m.querySelector(".np-bubble");
    const q = m.querySelector(".np-quote");
    return {
      text: b ? [...b.childNodes].filter((n) => !n.classList?.contains("np-time")).map((n) => n.textContent).join("") : "",
      gif: !!m.querySelector(".np-gif"),
      mid: m.dataset.mid || null,
      mine: m.classList.contains("np-mine"),
      quote: q ? { name: q.querySelector(".np-quote-name").textContent, s: q.querySelector(".np-quote-s").textContent } : null,
      reacts: [...m.querySelectorAll(".np-rchip")].map((c) => ({ e: c.dataset.emoji, n: Number(c.querySelector(".np-rn").textContent), mine: c.classList.contains("np-rmine"), title: c.title })),
    };
  });
});
const lineOf = async (p, text) => ((await lines(p)) || []).find((l) => l.text === text);
const msgLoc = (p, text) => p.locator(".np-msg").filter({ has: p.locator(".np-bubble", { hasText: text }) }).last();
const gifLoc = (p) => p.locator(".np-msg").filter({ has: p.locator("img.np-gif") }).last();
const strip = (p) => sh(p, (r) => { const s = r.querySelector(".np-replybar"); return s && !s.hidden ? s.textContent : null; });
const overflow = (p) => sh(p, (r) => { const pn = r.querySelector(".np-panel"), c = r.querySelector(".np-chat"); return { panel: pn.scrollWidth - pn.clientWidth, chat: c.scrollWidth - c.clientWidth }; });
const hot = (p) => p.evaluate(() => window.__hotkeys);
const hot0 = { h: await hot(hp), g: await hot(gp) };

// ---- reply: hover shows the bar, Reply shows the strip, Esc / X cancel it
await send(gp, "ORIG pizza tonight?");
check("host got the guest's line", !!(await until(async () => await lineOf(hp, "ORIG pizza tonight?"))));
const orig = await lineOf(hp, "ORIG pizza tonight?");
check("chat lines carry a message id", /^[A-Za-z0-9_-]{12}$/.test(orig?.mid || ""), JSON.stringify(orig));
check("no action bar before hovering", !(await msgLoc(hp, "ORIG pizza").locator(".np-acts").isVisible().catch(() => false)));
await msgLoc(hp, "ORIG pizza").hover();
check("hovering a line shows Reply + React", (await msgLoc(hp, "ORIG pizza").locator(".np-act-reply").isVisible()) && (await msgLoc(hp, "ORIG pizza").locator(".np-act-react").isVisible()));
const bar = await sh(hp, (r) => { const a = r.querySelector(".np-acts").getBoundingClientRect(), c = r.querySelector(".np-chat").getBoundingClientRect(); return { inside: a.left >= c.left && a.right <= c.right, w: Math.round(a.width) }; });
check("action bar stays inside the chat (no overflow while hovered)", bar.inside && (await overflow(hp)).chat <= 0 && (await overflow(hp)).panel <= 0, JSON.stringify([bar, await overflow(hp)]));
await msgLoc(hp, "ORIG pizza").locator(".np-act-reply").click();
check("Reply shows 'Replying to Rahul: <snippet>' above the input", (await strip(hp)) === "Replying to Rahul: ORIG pizza tonight?", String(await strip(hp)));
check("…and the chat box has focus", await sh(hp, (r) => r.activeElement?.classList.contains("np-input")));
await hp.keyboard.press("Escape");
check("Esc cancels the reply, panel stays open", (await strip(hp)) === null && (await hp.locator(".np-panel").isVisible()));
await msgLoc(hp, "ORIG pizza").hover();
await msgLoc(hp, "ORIG pizza").locator(".np-act-reply").click();
check("strip back", !!(await strip(hp)));
await hp.locator(".np-replybar-x").click();
check("X cancels the reply", (await strip(hp)) === null);
// touch: a tap on a line shows its bar (no hover on touch screens)
await sh(gp, (r) => {
  const m = [...r.querySelectorAll(".np-msg")].pop();
  const b = m.querySelector(".np-bubble");
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, pointerType: "touch" }));
  b.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true, pointerType: "touch" }));
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
});
check("touch: tapping a line shows its action bar", !!(await sh(gp, (r) => { const m = [...r.querySelectorAll(".np-msg")].pop(); return m.classList.contains("np-acts-on") && getComputedStyle(m.querySelector(".np-acts")).display === "flex"; })));
await sh(gp, (r) => { const b = [...r.querySelectorAll(".np-msg")].pop().querySelector(".np-bubble"); b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, pointerType: "touch" })); b.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); });
check("touch: tapping it again hides it", !(await sh(gp, (r) => [...r.querySelectorAll(".np-msg")].pop().classList.contains("np-acts-on"))));
await sh(gp, (r) => r.querySelector(".np-chat").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, pointerType: "mouse" })));

// push the original out of view: 24 lines from two people (under the 20 per 10 s limit each)
for (let i = 1; i <= 12; i++) {
  await send(gp, "filler g" + i);
  await send(hp, "filler h" + i);
  await sleep(450);
}
check("fillers arrived", !!(await until(async () => (await lineOf(gp, "filler h12")) && (await lineOf(hp, "filler g12")), 15000)));
await msgLoc(hp, "ORIG pizza").hover();
await msgLoc(hp, "ORIG pizza").locator(".np-act-reply").click();
check("reply to a line scrolled up", (await strip(hp)) === "Replying to Rahul: ORIG pizza tonight?");
await hp.screenshot({ path: "c2-reply-strip.png" });
await hp.keyboard.type("REPLY yes with extra cheese");
await hp.keyboard.press("Enter");
check("strip goes away once sent", (await strip(hp)) === null);
const rH = await until(async () => { const l = await lineOf(hp, "REPLY yes with extra cheese"); return l?.quote && l; });
const rG = await until(async () => { const l = await lineOf(gp, "REPLY yes with extra cheese"); return l?.quote && l; });
check("reply shows the quote (name + snippet) for the sender", rH?.quote?.name === "Rahul" && rH.quote.s === "ORIG pizza tonight?" && rH.mine, JSON.stringify(rH));
check("reply shows the quote for the friend", rG?.quote?.name === "Rahul" && rG.quote.s === "ORIG pizza tonight?" && !rG.mine, JSON.stringify(rG));
const botReply = bot.got.find((x) => x.p?.text === "REPLY yes with extra cheese")?.p;
check("reply payload: { text, mid, re: { id, uid, name, s } } inside the encryption", botReply?.re?.id === orig.mid && botReply.re.s === "ORIG pizza tonight?" && botReply.re.name === "Rahul" && typeof botReply.re.uid === "string" && /^[A-Za-z0-9_-]{12}$/.test(botReply.mid), JSON.stringify(botReply));
// the original is out of view on the guest's side; clicking the quote scrolls to it and flashes it
const vis = (p, text) => sh(p, (r, t) => {
  const c = r.querySelector(".np-chat").getBoundingClientRect();
  const m = [...r.querySelectorAll(".np-msg")].find((n) => n.querySelector(".np-bubble")?.firstChild?.textContent === t);
  const b = m.getBoundingClientRect();
  return { inView: b.top >= c.top && b.bottom <= c.bottom, flash: m.classList.contains("np-flash") };
}, text);
check("original is out of view before the click", !(await vis(gp, "ORIG pizza tonight?")).inView, JSON.stringify(await vis(gp, "ORIG pizza tonight?")));
await msgLoc(gp, "REPLY yes with extra cheese").locator(".np-quote").click();
await sleep(150);
const v1 = await vis(gp, "ORIG pizza tonight?");
check("clicking the quote scrolls to the original and highlights it", v1.inView && v1.flash, JSON.stringify(v1));
await sleep(2000);
check("…the highlight fades", !(await vis(gp, "ORIG pizza tonight?")).flash);

// ---- reply to a GIF (sent by the scripted member the way 2.0.x does: no message id)
await bot.say({ t: "gif", url: "https://static.klipy.com/test/bot1.gif", w: 200, h: 150 });
check("GIF line shows", !!(await until(() => sh(hp, (r) => r.querySelectorAll(".np-msg img.np-gif").length === 1))));
const gifMid = await sh(hp, (r) => [...r.querySelectorAll(".np-msg")].find((m) => m.querySelector(".np-gif"))?.dataset.mid);
check("line without a message id (2.0.x sender) gets one from its ciphertext", /^~[A-Za-z0-9_-]{16}$/.test(gifMid || ""), String(gifMid));
await gifLoc(hp).hover();
await gifLoc(hp).locator(".np-act-reply").click();
check("reply strip for a GIF says GIF", (await strip(hp)) === "Replying to Bottie: GIF", String(await strip(hp)));
await hp.keyboard.type("REPLY2 nice gif");
await hp.keyboard.press("Enter");
const g2 = await until(async () => { const l = await lineOf(gp, "REPLY2 nice gif"); return l?.quote && l; });
check("reply to a GIF shows 'GIF' in the quote on both sides", g2?.quote?.name === "Bottie" && g2.quote.s === "GIF" && (await lineOf(hp, "REPLY2 nice gif"))?.quote?.s === "GIF", JSON.stringify(g2));
const botReply2 = bot.got.find((x) => x.p?.text === "REPLY2 nice gif")?.p;
check("…quote carries g:1 and the ciphertext-derived id", botReply2?.re?.g === 1 && botReply2.re.id === gifMid && !("s" in botReply2.re), JSON.stringify(botReply2));
await sh(gp, (r) => { const c = r.querySelector(".np-chat"); c.scrollTop = 0; });
await msgLoc(gp, "REPLY2 nice gif").locator(".np-quote").click();
await sleep(150);
check("clicking a GIF quote jumps to the GIF", !!(await sh(gp, (r) => { const m = [...r.querySelectorAll(".np-msg")].find((n) => n.querySelector(".np-gif")); const c = r.querySelector(".np-chat").getBoundingClientRect(), b = m.getBoundingClientRect(); return m.classList.contains("np-flash") && b.bottom > c.top && b.top < c.bottom; })));

// ---- reactions on messages
await msgLoc(hp, "REPLY yes with extra cheese").hover();
await msgLoc(hp, "REPLY yes with extra cheese").locator(".np-act-react").click();
check("React opens the quick-pick row (6 + more)", (await hp.locator(".np-qreact.np-pop-open").isVisible()) && (await sh(hp, (r) => [...r.querySelectorAll(".np-qreact .np-qbtn")].map((b) => b.dataset.emoji || b.textContent).join(" "))) === "👍 ❤️ 😂 😮 😢 🔥 +");
await hp.screenshot({ path: "c2-quick.png" });
const qBox = await sh(hp, (r) => { const p = r.querySelector(".np-panel").getBoundingClientRect(), q = r.querySelector(".np-qreact").getBoundingClientRect(); return q.left >= p.left && q.right <= p.right && q.top >= p.top && q.bottom <= p.bottom; });
check("quick-pick row fits inside the panel", qBox);
await hp.locator('.np-qreact .np-qbtn[data-emoji="❤️"]').click();
check("row closes after picking", !(await hp.locator(".np-qreact").isVisible()));
const chip = async (p, text, e) => (await lineOf(p, text))?.reacts.find((x) => x.e === e) || null;
const R = "REPLY yes with extra cheese";
check("❤️ 1 on both sides, mine highlighted for the sender only", !!(await until(async () => { const a = await chip(hp, R, "❤️"), b = await chip(gp, R, "❤️"); return a?.n === 1 && a.mine && b?.n === 1 && !b.mine; })), JSON.stringify([await chip(hp, R, "❤️"), await chip(gp, R, "❤️")]));
check("chip title says who reacted", (await chip(gp, R, "❤️"))?.title === "Chirag", (await chip(gp, R, "❤️"))?.title);
await msgLoc(gp, R).locator('.np-rchip[data-emoji="❤️"]').click();
check("friend taps the chip: ❤️ 2 on both sides, now mine for both", !!(await until(async () => { const a = await chip(hp, R, "❤️"), b = await chip(gp, R, "❤️"); return a?.n === 2 && a.mine && b?.n === 2 && b.mine; })), JSON.stringify([await chip(hp, R, "❤️"), await chip(gp, R, "❤️")]));
check("title lists both", /^You, Rahul/.test((await chip(hp, R, "❤️"))?.title || "") && /^Chirag, You/.test((await chip(gp, R, "❤️"))?.title || ""), JSON.stringify([(await chip(hp, R, "❤️"))?.title, (await chip(gp, R, "❤️"))?.title]));
await msgLoc(gp, R).locator('.np-rchip[data-emoji="❤️"]').click();
check("tapping again takes it back: ❤️ 1, not mine for the friend", !!(await until(async () => { const a = await chip(hp, R, "❤️"), b = await chip(gp, R, "❤️"); return a?.n === 1 && b?.n === 1 && !b.mine; })));
// quick pick toggles too
for (let i = 0; i < 2; i++) {
  await msgLoc(hp, "filler g12").hover();
  await msgLoc(hp, "filler g12").locator(".np-act-react").click();
  await hp.locator('.np-qreact .np-qbtn[data-emoji="👍"]').click();
  if (i === 0) check("👍 from the quick row", !!(await until(async () => (await chip(gp, "filler g12", "👍"))?.n === 1)));
}
check("👍 picked again from the quick row removes it", !!(await until(async () => !(await chip(gp, "filler g12", "👍")) && !(await chip(hp, "filler g12", "👍")))));
// "+" opens the full picker (search focused), Enter reacts with the first result
await msgLoc(gp, R).hover();
await msgLoc(gp, R).locator(".np-act-react").click();
await gp.locator(".np-qreact .np-qmore").click();
check("+ opens the emoji picker for this message", (await gp.locator(".np-emoji-pop.np-for-msg.np-pop-open").isVisible()) && !(await gp.locator(".np-qreact").isVisible()));
check("…with the search box focused", !!(await until(() => sh(gp, (r) => r.activeElement?.classList.contains("np-emo-search")), 1500, 50)));
await gp.keyboard.type("unicorn");
await gp.keyboard.press("Enter");
check("search + Enter reacts 🦄 (both sides), picker closes", !!(await until(async () => (await chip(hp, R, "🦄"))?.n === 1 && (await chip(gp, R, "🦄"))?.mine)) && !(await gp.locator(".np-emoji-pop").isVisible()));
// a picked emoji from the grid works too
await gifLoc(hp).hover();
await gifLoc(hp).locator(".np-act-react").click();
await hp.locator(".np-qreact .np-qmore").click();
await hp.locator('.np-emo-sec[data-cat="smileys"] .np-emo-btn[data-emoji="😂"]').click();
check("react to a 2.0.x line (ciphertext id) from the picker grid", !!(await until(() => sh(gp, (r) => { const m = [...r.querySelectorAll(".np-msg")].find((n) => n.querySelector(".np-gif")); return m.querySelector('.np-rchip[data-emoji="😂"]'); }))));
const botMr = bot.got.filter((x) => x.p?.t === "mr").map((x) => x.p);
check("reaction payload: { t: 'mr', id, e, on }", botMr.some((p) => p.id === gifMid && p.e === "😂" && p.on === true) && botMr.some((p) => p.e === "❤️" && p.on === false), JSON.stringify(botMr.slice(0, 3)));
// invalid / dangling reactions are ignored
await bot.say({ t: "mr", id: "NOTHEREATALL", e: "🎃", on: true });
await bot.say({ t: "mr", id: orig.mid, e: "not an emoji", on: true });
await bot.say({ t: "mr", id: orig.mid, e: "👍👍", on: true });
await bot.say({ t: "mr", id: orig.mid, e: "🍕", on: true });
check("bad reactions ignored, a good one from a 3rd member shows", !!(await until(async () => (await lineOf(hp, "ORIG pizza tonight?"))?.reacts.map((x) => x.e).join() === "🍕")) && !(await sh(hp, (r) => r.querySelector('.np-rchip[data-emoji="🎃"]'))));
check("no reaction rendered as a chat line", (await lines(hp)).every((l) => l.text || l.gif));
await hp.screenshot({ path: "c2-host-dark.png" });
await gp.screenshot({ path: "c2-guest-light.png" });
check("reply quotes + chips don't overflow the panel", (await overflow(hp)).chat <= 0 && (await overflow(gp)).chat <= 0 && (await overflow(hp)).panel <= 0, JSON.stringify([await overflow(hp), await overflow(gp)]));
// bigger text: still no overflow
await H.sw.evaluate(() => chrome.storage.sync.set({ chatFont: "l" }));
await sleep(500);
check("large text size: no overflow", (await overflow(hp)).chat <= 0 && (await overflow(hp)).panel <= 0, JSON.stringify(await overflow(hp)));
await H.sw.evaluate(() => chrome.storage.sync.set({ chatFont: "m" }));

// ---- reload: replies and reactions come back from the (encrypted) history
await gp.reload();
const afterReload = await until(async () => { const l = await lineOf(gp, R); return l?.quote && l.reacts.length >= 2 && l; }, 20000);
check("after reload: the reply still shows its quote", afterReload?.quote?.s === "ORIG pizza tonight?" && afterReload.quote.name === "Rahul", JSON.stringify(afterReload));
check("after reload: reactions folded onto their lines (❤️ 1, 🦄 1 mine)", JSON.stringify(afterReload?.reacts.map((x) => [x.e, x.n, x.mine])) === JSON.stringify([["❤️", 1, false], ["🦄", 1, true]]), JSON.stringify(afterReload?.reacts));
check("after reload: 👍 toggled off stays off, 🍕 on ORIG, 😂 on the GIF", !(await chip(gp, "filler g12", "👍")) && (await chip(gp, "ORIG pizza tonight?", "🍕"))?.n === 1 && !!(await sh(gp, (r) => [...r.querySelectorAll(".np-msg")].find((n) => n.querySelector(".np-gif"))?.querySelector('.np-rchip[data-emoji="😂"]'))));
check("after reload: GIF reply still says GIF", (await lineOf(gp, "REPLY2 nice gif"))?.quote?.s === "GIF");
check("after reload: no empty / reaction lines", (await lines(gp)).every((l) => l.text || l.gif));
await msgLoc(gp, R).locator(".np-quote").click();
await sleep(150);
check("after reload: quote still jumps to the original", (await vis(gp, "ORIG pizza tonight?")).flash);

// ---- emoji search (insert mode, host)
await hp.locator(".np-input").click();
await hp.keyboard.type("yum ");
await hp.locator('.np-tool[aria-label="Emoji"]').click();
check("picker has a search box on top", await hp.locator(".np-emoji-pop .np-emo-search").isVisible());
check("…and the chat box keeps focus when the picker opens", await sh(hp, (r) => r.activeElement?.classList.contains("np-input")));
const pBox = await sh(hp, (r) => { const p = r.querySelector(".np-panel").getBoundingClientRect(), e = r.querySelector(".np-emoji-pop").getBoundingClientRect(); return e.left >= p.left && e.right <= p.right && e.top >= 0 && e.bottom <= innerHeight; });
check("picker with search still fits inside the panel", pBox);
await hp.locator(".np-emo-search").click();
await hp.keyboard.type("pizza");
const res = () => sh(hp, (r) => [...r.querySelectorAll(".np-emoji-pop .np-emo-btn")].filter((b) => b.offsetParent).map((b) => b.dataset.emoji));
await hp.screenshot({ path: "c2-search.png" });
check("typing filters across categories by name", (await res())[0] === "🍕" && (await res()).length <= 3, JSON.stringify(await res()));
check("…recent row and tabs hidden while searching", await sh(hp, (r) => r.querySelector('[data-cat="recent"]').hidden && r.querySelector(".np-emo-tabs").hidden));
await hp.locator(".np-emo-search").fill("");
await hp.keyboard.type("tears joy");
check("several words: all must match (😂)", (await res())[0] === "😂", JSON.stringify(await res()));
await hp.locator(".np-emo-search").fill("");
await hp.keyboard.type("lol");
check("keywords match too (lol → 😂)", (await res()).includes("😂"), JSON.stringify(await res()));
await hp.locator(".np-emo-search").fill("");
await hp.keyboard.type("heart");
check("no duplicates in results", new Set(await res()).size === (await res()).length && (await res()).length >= 5, JSON.stringify(await res()));
await hp.locator(".np-emo-search").fill("");
await hp.keyboard.type("zzqxv");
check("no results: 'No emoji found'", (await res()).length === 0 && (await hp.locator(".np-emo-empty").isVisible()) && (await hp.locator(".np-emo-empty").textContent()) === "No emoji found");
await hp.keyboard.press("Escape");
check("Esc clears the search first (picker stays open)", (await hp.locator(".np-emo-search").inputValue()) === "" && (await hp.locator(".np-emoji-pop").isVisible()) && (await res()).length > 150);
await hp.keyboard.press("Escape");
check("second Esc closes the picker, panel stays open", !(await hp.locator(".np-emoji-pop").isVisible()) && (await hp.locator(".np-panel").isVisible()));
await hp.locator('.np-tool[aria-label="Emoji"]').click();
await hp.locator(".np-emo-search").click();
await hp.keyboard.type("fire");
await hp.keyboard.press("Enter");
check("Enter inserts the first result at the caret", (await hp.locator(".np-input").inputValue()) === "yum 🔥", JSON.stringify(await hp.locator(".np-input").inputValue()));
check("…and the chat box has focus again", await sh(hp, (r) => r.activeElement?.classList.contains("np-input")));
check("…recently used row updated", (await sh(hp, (r) => r.querySelector('[data-cat="recent"] .np-emo-btn')?.dataset.emoji)) === "🔥");
await hp.keyboard.press("Escape");
check("search is cleared next time the picker opens", (await hp.locator(".np-emo-search").inputValue()) === "");
await hp.keyboard.press("Enter");
check("message with the searched emoji sent", !!(await until(async () => await lineOf(gp, "yum 🔥"))));
check("no site hotkeys fired while typing in search / chat (space, f, Enter)", (await hot(hp)) === hot0.h && (await hot(gp)) === hot0.g, JSON.stringify([await hot(hp), await hot(gp), hot0]));
// the floating 🎉 reactions still work
await hp.locator('.np-tool[aria-label="Reactions"]').click();
await hp.locator('.np-react-btn[data-emoji="😂"]').click();
check("floating 🎉 reactions still fly", !!(await until(() => sh(gp, (r) => r.querySelector(".np-fly")), 3000, 50)));
await hp.keyboard.press("Escape");

// ---- the 2.0.x client: replies read as plain text, reactions never show up as lines
const oldLines = await lines(op);
check("2.0.x: sees the reply as a normal message", oldLines.some((l) => l.text === R) && oldLines.some((l) => l.text === "REPLY2 nice gif"), JSON.stringify(oldLines.slice(-4)));
check("2.0.x: no empty or garbage lines for reactions", oldLines.every((l) => l.text || l.gif) && oldLines.length === (await lines(hp)).length, `${oldLines.length} vs ${(await lines(hp)).length}`);
check("2.0.x: no 'can't decrypt' warning", !(await sh(op, (r) => [...r.querySelectorAll(".np-sys")].some((n) => /decrypt/i.test(n.textContent)))));
await op.reload();
const oldAfter = await until(async () => { const l = await lines(op); return l?.length >= oldLines.length && l; }, 20000);
await sleep(1000);
check("2.0.x after reload (history with reactions): same lines, nothing extra", !!oldAfter && oldAfter.length === oldLines.length && oldAfter.every((l) => l.text || l.gif), `${oldAfter?.length} vs ${oldLines.length}`);

// ---- what the server saw
const secret = ["Chirag", "Rahul", "Bottie", "Oldie", "ORIG pizza", "pizza tonight", "REPLY", "extra cheese", "nice gif", "filler", "yum", "static.klipy.com", "bot1.gif",
  "❤️", "❤", "🦄", "👍", "😂", "🍕", "🔥", "🎃", "🦊", "🐼", "🐢", "🤖", KEY];
check("tap saw the chat", T.frames.filter((f) => f.text.includes('"type":"chat"')).length >= 30, String(T.frames.length));
check("no WebSocket frame contains a snippet, reaction emoji, name or message", leaks(T.frames, secret).length === 0, JSON.stringify(leaks(T.frames, secret)));
check("no plaintext reply / reaction fields in any frame", !T.frames.some((f) => /"(re|mr|mid|s|e|text|name|emoji|gif)":/.test(f.text)), T.frames.find((f) => /"(re|mr|mid|s|e|text|name|emoji|gif)":/.test(f.text))?.text.slice(0, 160));
const srvLog = fs.readFileSync("/tmp/np-server.log", "utf8");
check("server log has none of it either", leaks([{ text: srvLog }], secret).length === 0, JSON.stringify(leaks([{ text: srvLog }], secret)));

check("no script errors on the pages", errors.length === 0, errors.join(" | "));
bot.close();
T.close();
const f = summary("CHAT 2.1");
await H.ctx.close();
await G.ctx.close();
await O.ctx.close();
process.exit(f ? 1 : 0);
