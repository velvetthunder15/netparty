import path from "node:path";
import { REPO, MEDIA_DIR, SERVER_LOG, tempPath } from "./config.mjs";
// 2.2 e2e (fake Netflix): typing indicator, @mentions, spoilers, edit + delete, the pinned message,
// buffer-aware sync (a real stalled <video>: fakesite's /gate.webm holds the guest's video data), pause when a
// member drops, and auto-duck in voice chat (a 440 Hz tone as the guest's microphone).
// Browsers: host Chirag (dark), guest Rahul (light, "speaks" a tone in voice), guest "Priya Sharma" (a name with a
// space), a real 2.1.0 build (git 761eb86) for backward compatibility, a scripted member "Bottie" that decrypts
// every line (payload checks) and forges edits / deletes, and at the end a real 2.0.2 build (git 52ed769) that
// joins late and replays the history. Everything goes through a recording proxy: no WebSocket frame may carry a
// name, message, spoiler, mention or pin in the clear.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { launch, until, people, check, summary, out, sleep, tap, leaks, keyOf } from "./lib.mjs";
import { WebSocket } from "ws";
const SITE = "https://www.netflix.com/watch/12345";
const T = tap(8792, 8787);
const gate = (open) => fetch(`http://localhost:8444/__gate?g=g1&open=${open ? 1 : 0}`).then((r) => r.json());
await gate(true);

// old builds straight from git
const oldBuild = (rev, name) => {
  const dir = tempPath(name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // argument arrays: checkout paths with spaces work and the revision is never shell code
  const archive = execFileSync("git", ["-C", REPO, "archive", "--format=tar", rev, "extension"]);
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  return dir + "/extension";
};
const OLD21 = oldBuild(process.env.OLD21 || "761eb86e27cdb44e46c423e4607b8de073fe1f30", "np-old21");
const OLD20 = oldBuild(process.env.OLD20 || "52ed7690633fbc2f6f4a343aa2a724596bebc800", "np-old20");
const ver = (d) => JSON.parse(fs.readFileSync(d + "/manifest.json", "utf8")).version;

// the guest's microphone: a speech-like tone (a wobbling 300 Hz note, never silent), generated once
const TONE = path.join(MEDIA_DIR, "tone.wav");
if (!fs.existsSync(TONE))
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=0.5*(0.7+0.3*sin(2*PI*4*t))*sin(2*PI*(300+150*sin(2*PI*0.7*t))*t):s=48000:d=12", "-ac", "1", "-c:a", "pcm_s16le", TONE]);
const H = await launch("pw-c3h", { name: "Chirag", avatar: "🦊", extra: { serverUrl: T.url, theme: "dark" } });
const G = await launch("pw-c3g", { name: "Rahul", avatar: "🐼", extra: { serverUrl: T.url, theme: "light" }, args: [`--use-file-for-fake-audio-capture=${TONE}`] });
const P = await launch("pw-c3p", { name: "Priya Sharma", avatar: "🐨", extra: { serverUrl: T.url, theme: "dark" } });
const O = await launch("pw-c3o", { name: "Oldie", avatar: "🐢", extra: { serverUrl: T.url }, ext: OLD21 });
const hp = await H.ctx.newPage(), gp = await G.ctx.newPage(), op = await O.ctx.newPage();
let pp = await P.ctx.newPage();
const errors = [];
const watch = (p, n) => {
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  p.on("console", (m) => {
    if (m.type() === "error" && !/Content Security Policy|ERR_|status of 40|Failed to load resource/.test(m.text())) errors.push(n + " console: " + m.text());
    if (process.env.DEBUG && /NetParty/.test(m.text())) out(n + ":", m.text().slice(0, 200));
  });
};
for (const [p, n] of [[hp, "host"], [gp, "guest"], [pp, "priya"], [op, "old"]]) watch(p, n);

// the guest's video comes from /gate.webm (its loading is ours to hold)
await gp.goto("https://www.netflix.com/browse");
await gp.evaluate(() => (localStorage.fakeGate = "g1"));
await hp.goto(SITE);
await hp.waitForTimeout(2000);
const created = await H.sw.evaluate(async (url) => {
  const [t] = await chrome.tabs.query({ url: url + "*" });
  return chrome.tabs.sendMessage(t.id, { cmd: "create" });
}, SITE);
check("party created", !!created?.invite, JSON.stringify(created));
const KEY = keyOf(created.invite);
const ROOM = created.invite.match(/\/j\/([a-z0-9]+)/)[1];
for (const p of [gp, pp, op]) {
  await p.goto(created.invite);
  await Promise.all([p.waitForNavigation(), p.click("a.btn")]);
}
check(`everyone joined (2.2 ×3 + ${ver(OLD21)})`, !!(await until(async () => (await people(hp)).length === 4 && (await people(op)).length === 4 && (await people(pp)).length === 4, 30000)));
check("guest plays the gated video", !!(await until(() => gp.evaluate(() => /gate\.webm/.test(document.querySelector("#v").src) && document.querySelector("#v").readyState >= 3), 8000)));

// ---- scripted member (decrypts everything; forges edits / deletes)
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
  const got = [], evs = [], pins = [];
  let seq = 0;
  const replies = new Map();
  ws.on("message", async (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "reply") return replies.get(m.reqId)?.(m);
    if (m.type === "chat") got.push({ from: m.data.from, p: await openCt("chat", m.data.from, m.data.ct) });
    if (m.type === "ev") evs.push({ from: m.data.from, p: await openCt("ev", m.data.from, m.data.ct), at: Date.now() });
    if (m.type === "pin") pins.push(m.data.ct ? await openCt("pin", m.data.by, m.data.ct) : null);
  });
  await new Promise((r) => ws.once("open", r));
  const req = (type, data) => {
    const reqId = ++seq;
    ws.send(JSON.stringify({ type, reqId, data }));
    return new Promise((res, rej) => replies.set(reqId, (m) => (m.error ? rej(new Error(m.error)) : res(m.data))));
  };
  const snap = await req("join", { e2ee: 1, roomId: ROOM, cid: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex") });
  await req("profile", { ct: await seal("profile", snap.you, { name: "Bottie", avatar: "🤖" }) });
  return { pid: snap.you, got, evs, pins, say: async (obj) => req("chat", { ct: await seal("chat", snap.you, obj) }), close: () => ws.close() };
})();
check("scripted member joined", !!(await until(async () => (await people(hp)).length === 5, 10000)));

// ---- helpers
const sh = (p, fn, arg) => p.evaluate(([src, a]) => { const r = document.getElementById("netparty-root")?.shadowRoot; return r ? new Function("return " + src)()(r, a) : null; }, [fn.toString(), arg]);
const send = async (p, t) => { await p.locator(".np-input").click(); await p.keyboard.type(t); await p.keyboard.press("Enter"); };
const lines = (p) => sh(p, (r) => [...r.querySelectorAll(".np-msg")].map((m) => {
  const b = m.querySelector(".np-bubble");
  const q = m.querySelector(".np-quote");
  return {
    text: b ? [...b.childNodes].filter((n) => !n.classList?.contains("np-time") && !n.classList?.contains("np-edited")).map((n) => n.textContent).join("") : "",
    edited: !!m.querySelector(".np-edited"), deleted: !!m.querySelector(".np-deleted"), atMe: m.classList.contains("np-at-me"),
    spoilers: [...m.querySelectorAll(".np-spoiler")].map((s) => ({ t: s.textContent, shown: s.classList.contains("np-shown"), blur: getComputedStyle(s.firstChild).filter })),
    mentions: [...m.querySelectorAll(".np-mention")].map((s) => ({ t: s.textContent, me: s.classList.contains("np-mention-me") })),
    gif: !!m.querySelector(".np-gif"), mid: m.dataset.mid || null, quote: q ? { name: q.querySelector(".np-quote-name").textContent, s: q.querySelector(".np-quote-s").textContent } : null,
    reacts: m.querySelectorAll(".np-rchip").length,
  };
}));
const lineOf = async (p, pred) => ((await lines(p)) || []).filter(typeof pred === "string" ? (l) => l.text === pred : pred).pop();
const msgLoc = (p, text) => p.locator(".np-msg").filter({ has: p.locator(".np-bubble", { hasText: text }) }).last();
const overflow = (p) => sh(p, (r) => { const pn = r.querySelector(".np-panel"), c = r.querySelector(".np-chat"); return { panel: pn.scrollWidth - pn.clientWidth, chat: c.scrollWidth - c.clientWidth }; });
const vid = (p) => p.evaluate(() => { const v = document.querySelector("#v"); return v ? { t: v.currentTime, paused: v.paused, rs: v.readyState, vol: v.volume } : null; });
const holdText = (p) => sh(p, (r) => { const h = r.querySelector(".np-hold"); return h && !h.hidden ? r.querySelector(".np-hold-txt").textContent : null; });
const typingText = (p) => sh(p, (r) => { const t = r.querySelector(".np-typing"); return t && !t.hidden ? t.textContent : null; });
const pinText = (p) => sh(p, (r) => { const b = r.querySelector(".np-pinbar"); return b && !b.hidden ? r.querySelector(".np-pin-txt").textContent : null; });
const hot = (p) => p.evaluate(() => window.__hotkeys);
const hot0 = { h: await hot(hp), g: await hot(gp), p: await hot(pp) };
const evUp = () => T.frames.filter((f) => f.dir === "up" && f.text.includes('"type":"ev"')).length;

await send(gp, "ORIG pizza tonight?");
check("chat works", !!(await until(async () => await lineOf(hp, "ORIG pizza tonight?"))));

// ================================================================ 6. typing indicator
await gp.locator(".np-input").click();
await gp.keyboard.type("hel");
check("typing: 'Rahul is typing…' above the host's chat box", (await until(() => typingText(hp), 4000)) === "Rahul is typing…", String(await typingText(hp)));
check("…and nothing on the typist's own panel", (await typingText(gp)) === null);
await pp.locator(".np-input").click();
await pp.keyboard.type("hm");
check("typing: two people → '2 people are typing…'", (await until(async () => ((await typingText(hp)) === "2 people are typing…" ? true : null), 4000)) === true, String(await typingText(hp)));
await hp.screenshot({ path: "c3-typing.png" });
const ev0 = evUp();
for (let i = 0; i < 14; i++) {
  await gp.keyboard.type("x");
  await sleep(500);
}
const evN = evUp() - ev0;
check("typing: sent at most once every 3 s while typing (7 s of typing → ≤ 3 signals)", evN >= 2 && evN <= 3, String(evN));
await gp.keyboard.press("Enter");
check("typing: the line arriving clears 'is typing' at once", !!(await until(async () => (await lineOf(hp, (l) => /^helx+$/.test(l.text))) && !/Rahul/.test((await typingText(hp)) || "") && (await typingText(hp)) !== "2 people are typing…", 1500, 50)), String(await typingText(hp)));
await pp.keyboard.press("Control+A");
await pp.keyboard.press("Backspace");
check("typing: expires 5 s after the last signal", !!(await until(async () => (await typingText(hp)) === null, 8000)), String(await typingText(hp)));
check("typing signal is { t: 'ty' } inside the encryption", bot.evs.some((e) => e.p?.t === "ty" && e.from !== bot.pid) && bot.evs.every((e) => e.p && typeof e.p.t === "string"));

// ================================================================ 7. @mentions
await sh(pp, (r) => r.querySelector(".np-close").click()); // Priya's chat is closed: the toast and badge show the mention
await hp.locator(".np-input").click();
await hp.keyboard.type("@");
const opts = () => sh(hp, (r) => { const n = r.querySelector(".np-mention-pop"); return n && !n.hidden ? [...n.querySelectorAll(".np-mention-name")].map((x) => x.textContent) : null; });
const all = await until(opts, 3000);
check("@ opens the member list (everyone but you)", !!all && all.includes("Rahul") && all.includes("Priya Sharma") && all.includes("Oldie") && !all.includes("Chirag"), JSON.stringify(all));
await hp.keyboard.type("sha");
check("…filtered by any word of the name (@sha → Priya Sharma)", JSON.stringify(await opts()) === '["Priya Sharma"]', JSON.stringify(await opts()));
await hp.screenshot({ path: "c3-mention-list.png" });
await hp.keyboard.press("Enter");
check("Enter puts '@Priya Sharma ' in the chat box", (await hp.locator(".np-input").inputValue()) === "@Priya Sharma ", await hp.locator(".np-input").inputValue());
check("…and closes the list", (await opts()) === null);
await hp.keyboard.type("look at this");
await hp.keyboard.press("Enter");
const mP = await until(() => lineOf(pp, (l) => l.text === "@Priya Sharma look at this"), 6000);
check("mentioned: my line is highlighted, the mention marked as me", mP?.atMe && mP.mentions[0]?.t === "@Priya Sharma" && mP.mentions[0].me, JSON.stringify(mP));
const toastP = await sh(pp, (r) => { const t = r.querySelector(".np-toast"); return { show: t.classList.contains("np-show"), at: t.classList.contains("np-toast-at"), text: t.textContent }; });
check("mentioned while the chat is closed: toast says 'mentioned you' (emphasised)", toastP.show && toastP.at && /Chirag mentioned you: @Priya Sharma look/.test(toastP.text), JSON.stringify(toastP));
const badgeP = await sh(pp, (r) => { const b = r.querySelector(".np-badge"); return { at: b.classList.contains("np-badge-at"), text: b.textContent }; });
check("…and the unread badge shows @", badgeP.at && /^@\d/.test(badgeP.text), JSON.stringify(badgeP));
const mG = await lineOf(gp, (l) => l.text === "@Priya Sharma look at this");
check("others see the mention highlighted, not as their own", mG && !mG.atMe && mG.mentions[0]?.t === "@Priya Sharma" && !mG.mentions[0].me, JSON.stringify(mG));
const mPay = bot.got.find((x) => x.p?.text === "@Priya Sharma look at this")?.p;
check("payload: text plus mn: [{ p: <pid>, i: 0, n: 13 }] (the name rides as typed)", mPay?.mn?.length === 1 && mPay.mn[0].i === 0 && mPay.mn[0].n === 13 && /^[a-z0-9]{12}$/.test(mPay.mn[0].p), JSON.stringify(mPay));
check("2.1.0 sees the mention as plain text", !!(await until(() => lineOf(op, "@Priya Sharma look at this"), 5000)));
await sh(pp, (r) => r.querySelector(".np-toggle").click());
check("opening the chat clears the badge", !!(await until(() => sh(pp, (r) => r.querySelector(".np-badge").style.display === "none"), 3000)));
// a typed mention (no list) and a rename
await send(gp, "hey @priya sharma and @Chirag!");
const typed = await until(() => lineOf(hp, (l) => l.text === "hey @Priya Sharma and @Chirag!"), 5000);
check("typed '@priya sharma' and '@Chirag' become mentions (current names shown)", typed?.mentions.map((x) => x.t).join() === "@Priya Sharma,@Chirag" && typed.atMe, JSON.stringify(typed));
await P.sw.evaluate(() => chrome.storage.sync.set({ name: "Priya S" }));
check("rename: mentions show the new name everywhere", !!(await until(async () => (await lineOf(gp, (l) => l.mentions[0]?.t === "@Priya S" && /look at this/.test(l.text)))?.mentions[0].t === "@Priya S", 6000)));
await P.sw.evaluate(() => chrome.storage.sync.set({ name: "Priya Sharma" }));
await until(async () => (await people(hp)).includes("Priya Sharma"), 5000);

// ================================================================ 8. spoilers
await send(gp, "the killer is ||the butler|| lol");
const spH = await until(() => lineOf(hp, (l) => l.text.startsWith("the killer is")), 5000);
check("spoiler: ||the butler|| renders blurred", spH?.spoilers.length === 1 && spH.spoilers[0].t === "the butler" && /blur/.test(spH.spoilers[0].blur) && !spH.spoilers[0].shown, JSON.stringify(spH));
await msgLoc(hp, "the killer is").locator(".np-spoiler").click();
await sleep(400); // the blur fades out
const spH2 = await lineOf(hp, (l) => l.text.startsWith("the killer is"));
check("tapping shows it (just for this viewer)", spH2.spoilers[0].shown && spH2.spoilers[0].blur === "none", JSON.stringify(spH2.spoilers));
check("…Priya's copy stays hidden", !(await lineOf(pp, (l) => l.text.startsWith("the killer is")))?.spoilers[0].shown);
await msgLoc(hp, "the killer is").locator(".np-spoiler").click();
check("tapping again hides it", !(await lineOf(hp, (l) => l.text.startsWith("the killer is"))).spoilers[0].shown);
const spPay = bot.got.find((x) => x.p?.sp)?.p;
check("payload: text 'the killer is [spoiler] lol' + sp: [{ i: 14, n: 9, s }]", spPay?.text === "the killer is [spoiler] lol" && spPay.sp[0].i === 14 && spPay.sp[0].n === 9 && spPay.sp[0].s === "the butler", JSON.stringify(spPay));
check("2.1.0 shows '[spoiler]', never the hidden text", !!(await until(() => lineOf(op, "the killer is [spoiler] lol"), 5000)) && !(await lines(op)).some((l) => /butler/.test(l.text)));
// the Spoiler switch: the whole message
await hp.locator(".np-tool-sp").click();
check("Spoiler switch on (pressed, placeholder says so)", (await hp.locator(".np-tool-sp").getAttribute("aria-pressed")) === "true" && /Spoiler/.test(await hp.locator(".np-input").getAttribute("placeholder")));
await hp.keyboard.type("everyone dies at the end");
await hp.keyboard.press("Enter");
const whole = await until(() => lineOf(gp, (l) => l.spoilers[0]?.t === "everyone dies at the end"), 5000);
check("whole-message spoiler arrives hidden", whole?.text === "everyone dies at the end" && !whole.spoilers[0].shown && whole.spoilers.length === 1, JSON.stringify(whole));
check("…and the switch turns itself off after sending", (await hp.locator(".np-tool-sp").getAttribute("aria-pressed")) === "false");
// replying to a spoiler quotes "Spoiler"
await msgLoc(hp, "the killer is").hover();
await msgLoc(hp, "the killer is").locator(".np-act-reply").click();
check("reply strip hides the spoiler ('Spoiler')", (await sh(hp, (r) => r.querySelector(".np-replybar").textContent)) === "Replying to Rahul: Spoiler");
await hp.keyboard.type("no way");
await hp.keyboard.press("Enter");
const rq = await until(() => lineOf(gp, (l) => l.text === "no way" && l.quote), 5000);
check("the reply's quote says 'Spoiler'", rq?.quote.s === "Spoiler", JSON.stringify(rq));
const rqPay = bot.got.find((x) => x.p?.text === "no way")?.p;
check("…and the quote in the payload carries no hidden text (sp: 1, s: 'Spoiler')", rqPay?.re?.sp === 1 && rqPay.re.s === "Spoiler" && !JSON.stringify(rqPay).includes("butler"), JSON.stringify(rqPay));
check("2.1.0 shows that quote as 'Spoiler' too", (await until(() => lineOf(op, (l) => l.text === "no way" && l.quote), 5000))?.quote.s === "Spoiler");
await hp.screenshot({ path: "c3-spoiler-dark.png" });

// ================================================================ 9. edit + delete
await send(hp, "typo mesage here");
await until(() => lineOf(gp, "typo mesage here"), 5000);
const oldCount = async () => (await lines(op)).length;
await until(() => lineOf(op, "typo mesage here"), 5000);
const oldN = await oldCount();
await msgLoc(gp, "typo mesage here").hover();
check("someone else's line: no Edit / Delete", !(await msgLoc(gp, "typo mesage here").locator(".np-act-edit").isVisible()) && !(await msgLoc(gp, "typo mesage here").locator(".np-act-del").isVisible()) && (await msgLoc(gp, "typo mesage here").locator(".np-act-reply").isVisible()));
await msgLoc(hp, "typo mesage here").hover();
check("own line: Edit and Delete in the action bar", (await msgLoc(hp, "typo mesage here").locator(".np-act-edit").isVisible()) && (await msgLoc(hp, "typo mesage here").locator(".np-act-del").isVisible()));
check("action bar (5 buttons) stays inside the chat", (await overflow(hp)).chat <= 0 && (await overflow(hp)).panel <= 0, JSON.stringify(await overflow(hp)));
await msgLoc(hp, "typo mesage here").locator(".np-act-edit").click();
check("Edit: the text goes back into the chat box with an 'Editing' strip", (await hp.locator(".np-input").inputValue()) === "typo mesage here" && (await hp.locator(".np-editbar").isVisible()));
await hp.keyboard.press("Escape");
check("Esc cancels editing (box emptied, strip gone)", (await hp.locator(".np-input").inputValue()) === "" && !(await hp.locator(".np-editbar").isVisible()));
await msgLoc(hp, "typo mesage here").hover();
await msgLoc(hp, "typo mesage here").locator(".np-act-edit").click();
await hp.locator(".np-input").fill("");
await hp.keyboard.type("typo message here, @Rahul");
await hp.keyboard.press("Enter");
const ed = await until(() => lineOf(gp, (l) => l.text === "typo message here, @Rahul" && l.edited), 5000);
check("edit shows everywhere with '(edited)' (mentions work in edits)", !!ed && ed.atMe && !!(await lineOf(hp, (l) => l.text === "typo message here, @Rahul" && l.edited)), JSON.stringify(ed));
check("no new line for the edit", !(await lines(gp)).some((l) => l.text === "typo mesage here"));
const edPay = bot.got.find((x) => x.p?.t === "me")?.p;
check("payload: { t: 'me', id, text, mn }", edPay?.id === ed?.mid && edPay.text === "typo message here, @Rahul" && edPay.mn?.length === 1, JSON.stringify(edPay));
await sleep(800);
check("2.1.0: edit is dropped silently (old text, no extra line)", (await oldCount()) === oldN && !!(await lineOf(op, "typo mesage here")), `${await oldCount()} vs ${oldN}`);
// forged edit / delete from someone else are ignored
const gOrig = await lineOf(hp, "ORIG pizza tonight?");
await bot.say({ t: "me", id: ed.mid, text: "HACKED edit" });
await bot.say({ t: "md", id: gOrig.mid });
await sleep(1200);
check("an edit from someone who didn't write the line is ignored", !(await lines(hp)).some((l) => /HACKED/.test(l.text)) && !(await lines(gp)).some((l) => /HACKED/.test(l.text)));
check("a delete from someone who didn't write the line is ignored", !(await lineOf(hp, "ORIG pizza tonight?")).deleted && !(await lineOf(gp, "ORIG pizza tonight?")).deleted);
// delete (two presses)
await send(hp, "delete me please");
await until(() => lineOf(gp, "delete me please"), 5000);
await msgLoc(gp, "delete me please").hover();
await msgLoc(gp, "delete me please").locator(".np-act-react").click();
await gp.locator('.np-qreact .np-qbtn[data-emoji="👍"]').click();
await until(async () => (await lineOf(hp, "delete me please"))?.reacts === 1, 5000);
await msgLoc(hp, "delete me please").hover();
await msgLoc(hp, "delete me please").locator(".np-act-del").click();
check("Delete asks once more (button turns red, nothing sent yet)", (await msgLoc(hp, "delete me please").locator(".np-act-del.np-act-confirm").isVisible()) && !(await lineOf(gp, (l) => l.deleted)));
await msgLoc(hp, "delete me please").locator(".np-act-del").click();
const del = await until(() => lineOf(gp, (l) => l.deleted), 5000);
check("delete: 'Message deleted' everywhere, reactions gone", del?.text === "Message deleted" && del.reacts === 0 && (await lineOf(hp, (l) => l.deleted))?.text === "Message deleted", JSON.stringify(del));
check("payload: { t: 'md', id }", bot.got.some((x) => x.p?.t === "md" && x.p.id === del?.mid && x.from !== bot.pid));
// history replay after a reload
await gp.reload();
const after = await until(async () => { const l = await lines(gp); return l?.some((x) => x.edited) && l.some((x) => x.deleted) ? l : null; }, 20000);
check("reload: the edit and the delete replay from the history", !!after && after.some((l) => l.text === "typo message here, @Rahul" && l.edited) && after.some((l) => l.deleted) && !after.some((l) => /HACKED|delete me please/.test(l.text)), JSON.stringify(after?.slice(-5)));
check("reload: the forged delete didn't stick", !(await lineOf(gp, "ORIG pizza tonight?"))?.deleted);
check("reload: spoilers still hidden, mentions still marked", (await lineOf(gp, (l) => l.text.startsWith("the killer is")))?.spoilers[0]?.shown === false && !!(await lineOf(gp, (l) => l.text === "typo message here, @Rahul"))?.atMe);
await op.reload();
await sleep(4000);
const oldAfter = await lines(op);
check("2.1.0 after reload: no garbage lines from edits / deletes / spoilers / mentions", oldAfter.every((l) => (l.text || l.gif) && !/"t":|\[object|undefined/.test(l.text)) && oldAfter.length === (await lines(hp)).length, `${oldAfter.length} vs ${(await lines(hp)).length}`);

// ================================================================ 10. pinned message
await msgLoc(hp, "ORIG pizza tonight?").hover();
await msgLoc(hp, "ORIG pizza tonight?").locator(".np-act-pin").click();
for (const [p, n] of [[hp, "host"], [gp, "guest"], [pp, "Priya"]])
  check(`pin: ${n} sees 'Rahul: ORIG pizza tonight?' above the chat`, (await until(() => pinText(p), 5000)) === "RahulORIG pizza tonight?", String(await pinText(p)));
const pinPay = bot.pins.at(-1);
check("pin payload { id, uid, name, s } (encrypted, kept by the server)", pinPay?.s === "ORIG pizza tonight?" && pinPay.name === "Rahul" && pinPay.id === gOrig.mid, JSON.stringify(pinPay));
await sh(pp, (r) => { r.querySelector(".np-chat").scrollTop = 0; });
await sh(pp, (r) => { r.querySelector(".np-chat").scrollTop = r.querySelector(".np-chat").scrollHeight; });
await pp.locator(".np-pin-txt").click();
await sleep(200);
check("clicking the pinned bar jumps to the message and flashes it", !!(await sh(pp, (r) => { const m = [...r.querySelectorAll(".np-msg")].find((n) => n.querySelector(".np-bubble")?.textContent.startsWith("ORIG pizza")); const c = r.querySelector(".np-chat").getBoundingClientRect(), b = m.getBoundingClientRect(); return m.classList.contains("np-flash") && b.top >= c.top && b.bottom <= c.bottom; })));
check("2.1.0 ignores the pin (no garbage)", (await oldCount()) === (await lines(op)).length && !(await op.evaluate(() => !!document.getElementById("netparty-root").shadowRoot.querySelector(".np-pinbar"))));
await pp.locator(".np-pin-x").click();
check("anyone may unpin while everyone controls playback (× by Priya clears it for all)", !!(await until(async () => (await pinText(hp)) === null && (await pinText(gp)) === null, 5000)));
// a spoiler pinned shows "Spoiler"
await msgLoc(hp, "the killer is").hover();
await msgLoc(hp, "the killer is").locator(".np-act-pin").click();
check("a pinned spoiler shows 'Spoiler', never the hidden text", (await until(() => pinText(gp), 5000)) === "RahulSpoiler" && !JSON.stringify(bot.pins.at(-1)).includes("butler"), String(await pinText(gp)));
await hp.screenshot({ path: "c3-pin-dark.png" });
await gp.screenshot({ path: "c3-pin-light.png" });
// host-only control: only the host pins / unpins
await H.sw.evaluate(async (url) => { const [t] = await chrome.tabs.query({ url: url + "*" }); return chrome.tabs.sendMessage(t.id, { cmd: "hostOnly", value: true }); }, SITE);
await sleep(800);
await msgLoc(pp, "ORIG pizza tonight?").hover();
check("host-only: Priya gets no Pin button and no ×", !(await msgLoc(pp, "ORIG pizza tonight?").locator(".np-act-pin").isVisible()) && !(await pp.locator(".np-pin-x").isVisible()));
await H.sw.evaluate(async (url) => { const [t] = await chrome.tabs.query({ url: url + "*" }); return chrome.tabs.sendMessage(t.id, { cmd: "hostOnly", value: false }); }, SITE);
await pp.reload();
check("reload: the pinned message comes back from the party (encrypted)", (await until(() => pinText(pp), 20000)) === "RahulSpoiler");
// deleting the pinned line hides the bar
await send(hp, "pin then delete");
await until(() => lineOf(hp, "pin then delete"), 5000);
await msgLoc(hp, "pin then delete").hover();
await msgLoc(hp, "pin then delete").locator(".np-act-pin").click();
await until(async () => (await pinText(gp)) === "Chiragpin then delete", 5000);
await msgLoc(hp, "pin then delete").hover();
await msgLoc(hp, "pin then delete").locator(".np-act-del").click();
await msgLoc(hp, "pin then delete").locator(".np-act-del").click();
check("deleting the pinned line hides the pinned bar", !!(await until(async () => (await pinText(gp)) === null && (await pinText(hp)) === null, 5000)));

// ================================================================ settings (panel + popup)
await hp.locator(".np-tool-set").click();
// (2.3: the host also gets a "Party" section with its own switches, [data-host-set], covered by v23.mjs)
check("Settings popover in the panel with 3 switches (all on by default)", (await hp.locator(".np-set-pop.np-pop-open").isVisible()) && JSON.stringify(await sh(hp, (r) => [...r.querySelectorAll(".np-switch[data-pref]")].map((b) => b.getAttribute("aria-checked")))) === '["true","true","true"]');
await hp.screenshot({ path: "c3-settings-dark.png" });
await hp.locator('.np-switch[data-pref="autoDuck"]').click();
check("switching one off saves it (storage.sync autoDuck: false)", (await H.sw.evaluate(() => chrome.storage.sync.get("autoDuck"))).autoDuck === false);
const pop = await H.ctx.newPage();
await pop.goto(`chrome-extension://${H.sw.url().split("/")[2]}/popup.html`);
await sleep(500);
check("the popup's Settings show the same", JSON.stringify(await pop.evaluate(() => [...document.querySelectorAll("[data-pref]")].map((b) => b.checked))) === "[true,true,false]");
await pop.evaluate(() => { document.getElementById("prefs").open = true; document.querySelector('[data-pref="autoDuck"]').click(); });
await sleep(300);
check("…and switching it back on in the popup reaches the panel", (await sh(hp, (r) => r.querySelector('.np-switch[data-pref="autoDuck"]').getAttribute("aria-checked"))) === "true" && !("autoDuck" in (await H.sw.evaluate(() => chrome.storage.sync.get("autoDuck")))));
await pop.screenshot({ path: "c3-popup-settings.png" });
await pop.close();
await hp.keyboard.press("Escape");
await gp.locator(".np-tool-set").click();
await gp.screenshot({ path: "c3-settings-light.png" });
await gp.keyboard.press("Escape");

// ================================================================ 1. buffer-aware sync
// the host decides; Priya and the 2.1.0 browser follow. The guest's video data is held at the fake site.
await H.sw.evaluate(() => chrome.storage.sync.set({ dropPause: false })); // the guest's reloads below aren't drops for this part
await hp.evaluate(() => { const v = document.querySelector("#v"); v.currentTime = 40; v.play(); });
await sleep(2500);
await gate(false);
await gp.reload();
const waitH = await until(async () => { const t = await holdText(hp); return t ? t : null; }, 20000);
check("stalled guest: everyone pauses with 'Waiting for Rahul to load…'", waitH === "Waiting for Rahul to load…" && (await until(async () => (await holdText(pp)) === "Waiting for Rahul to load…", 4000)), String(waitH));
check("…the guest's own panel says everyone is waiting for them", (await until(() => holdText(gp), 4000)) === "Your video is loading. Everyone is waiting for you…", String(await holdText(gp)));
const pausedAt = await until(async () => { const [a, b] = [await vid(hp), await vid(pp)]; return a.paused && b.paused ? a.t : null; }, 4000);
check("…host and Priya are paused (the 2.1.0 browser too)", pausedAt !== null && (await until(async () => (await vid(op)).paused, 3000)), JSON.stringify([await vid(hp), await vid(pp), await vid(op)]));
check("…the guest's video really is stuck loading", (await vid(gp)).rs < 3, JSON.stringify(await vid(gp)));
await hp.screenshot({ path: "c3-waiting-dark.png" });
await gp.screenshot({ path: "c3-waiting-light.png" });
await sleep(1500);
const still = await vid(hp);
check("…and stays paused while it loads (no flapping)", still.paused && Math.abs(still.t - pausedAt) < 0.3, JSON.stringify(still));
await gate(true);
const resumed = await until(async () => { const [a, b, c] = [await vid(hp), await vid(gp), await vid(pp)]; return !a.paused && !b.paused && !c.paused ? [a, b, c] : null; }, 10000);
check("loaded: everyone plays on together", !!resumed, JSON.stringify(resumed));
await sleep(1500);
const [r1, r2, r3] = [await vid(hp), await vid(gp), await vid(pp)];
check("…from the same moment (all within 1.2 s, ~where they paused)", Math.abs(r1.t - r2.t) < 1.2 && Math.abs(r1.t - r3.t) < 1.2 && r1.t > pausedAt && r1.t - pausedAt < 4, `h ${r1.t.toFixed(1)} g ${r2.t.toFixed(1)} p ${r3.t.toFixed(1)} paused at ${pausedAt.toFixed(1)}`);
check("…and the status line is gone", (await holdText(hp)) === null && (await holdText(gp)) === null);
check("2.1.0 browser plays on too", !(await vid(op)).paused);
const bufEv = bot.evs.filter((e) => e.p?.t === "buf");
check("signals: the stalled guest sent { t: 'buf', on: 1 } then on: 0; the host announced { t: 'wait' }", bufEv.some((e) => e.p.on === 1) && bufEv.some((e) => e.p.on === 0) && bot.evs.some((e) => e.p?.t === "wait" && e.p.on === 1 && e.p.ids?.length === 1), JSON.stringify(bot.evs.filter((e) => e.p?.t !== "ty").map((e) => e.p).slice(-6)));
check("buffering is not announced in the chat (no 'paused' lines)", !(await sh(pp, (r) => [...r.querySelectorAll(".np-sys")].some((n) => /Chirag (paused|played)/.test(n.textContent)))));
// a user's play during the wait wins (and isn't fought)
await gate(false);
await gp.reload();
await until(async () => ((await holdText(hp)) === "Waiting for Rahul to load…" ? true : null), 20000);
await sleep(2500); // (a player event within ~1 s of a party update is taken as the update's own echo)
await pp.evaluate(() => document.querySelector("#v").play());
const userPlay = await until(async () => { const [a, c] = [await vid(hp), await vid(pp)]; return !a.paused && !c.paused && (await holdText(hp)) === null ? true : null; }, 6000);
check("someone presses play while waiting: the party plays, the wait is over", !!userPlay, JSON.stringify([await vid(hp), await holdText(hp)]));
await sleep(5000);
check("…and the stalled guest doesn't pause it again", !(await vid(hp)).paused && (await holdText(hp)) === null);
await gate(true);
await until(async () => !(await vid(gp)).paused, 10000);
// switched off: no waiting
await H.sw.evaluate(() => chrome.storage.sync.set({ syncWait: false }));
await sleep(500);
await gate(false);
await gp.reload();
await sleep(7000);
check("'Wait when someone's video is loading' off: nobody waits", !(await vid(hp)).paused && (await holdText(hp)) === null);
await gate(true);
await H.sw.evaluate(() => chrome.storage.sync.remove("syncWait"));
await until(async () => !(await vid(gp)).paused, 10000);
// timeout: still loading after 20 s → play on with a note
await sleep(3500);
await gate(false);
await gp.reload();
const t0 = await until(async () => ((await holdText(hp)) === "Waiting for Rahul to load…" ? Date.now() : null), 20000);
const goOn = await until(async () => (!(await vid(hp)).paused ? Date.now() : null), 30000, 250);
check("still loading after 20 s: the party plays on anyway", !!t0 && !!goOn && goOn - t0 > 17000 && goOn - t0 < 25000, `${goOn && t0 ? goOn - t0 : "?"} ms`);
check("…with a note in the chat", !!(await until(() => sh(hp, (r) => [...r.querySelectorAll(".np-sys")].some((n) => n.textContent === "Rahul's video was still loading after 20 seconds, so the party played on.")), 3000)) && !!(await sh(pp, (r) => [...r.querySelectorAll(".np-sys")].some((n) => /still loading after 20 seconds/.test(n.textContent)))));
await sleep(4000);
check("…and doesn't pause again for the same guest right away", !(await vid(hp)).paused && (await holdText(hp)) === null);
await gate(true);
await until(async () => !(await vid(gp)).paused, 10000);
await H.sw.evaluate(() => chrome.storage.sync.remove(["syncWait", "dropPause"]));
await until(async () => !(await vid(gp)).paused && (await people(gp)).length === 5, 15000);

// ================================================================ 19. auto-duck
await hp.evaluate(() => (document.querySelector("#v").volume = 0.8));
await pp.evaluate(() => (document.querySelector("#v").volume = 0.65));
await sleep(600);
check("not in voice: the video volume is left alone", (await vid(hp)).vol === 0.8);
await hp.locator(".np-join-voice").click();
await gp.locator(".np-join-voice").click();
const speaking = await until(() => sh(hp, (r) => [...r.querySelectorAll(".np-person")].some((n) => n.classList.contains("np-speaking") && n.textContent.includes("Rahul"))), 20000);
check("voice: the guest's tone shows them speaking", !!speaking);
const samples = [];
for (let i = 0; i < 40 && (!samples.length || samples.at(-1) > 0.241); i++) {
  samples.push(Math.round((await vid(hp)).vol * 1000) / 1000);
  await sleep(40);
}
check("friend talking: the host's video goes down to 30% (0.8 → 0.24)", Math.abs(samples.at(-1) - 0.24) < 0.005, JSON.stringify(samples));
check("…smoothly (steps in between)", samples.some((v) => v < 0.79 && v > 0.25), JSON.stringify(samples));
check("…Priya (not in voice) is untouched", (await vid(pp)).vol === 0.65);
await gp.locator('.np-round[aria-label="Mute"]').click();
const back = await until(async () => ((await vid(hp)).vol === 0.8 ? Date.now() : null), 6000, 50);
check("friend stops: back to exactly 0.8", !!back, String((await vid(hp)).vol));
await gp.locator('.np-round[aria-label="Unmute"]').click();
await until(async () => Math.abs((await vid(hp)).vol - 0.24) < 0.005, 6000);
await hp.evaluate(() => (document.querySelector("#v").volume = 0.5));
await sleep(1500);
check("you change the volume while it's lowered: yours wins", (await vid(hp)).vol === 0.5);
await gp.locator('.np-round[aria-label="Mute"]').click();
await sleep(2000);
check("…and isn't put back over when they stop", (await vid(hp)).vol === 0.5);
await gp.locator('.np-round[aria-label="Unmute"]').click();
await until(async () => Math.abs((await vid(hp)).vol - 0.15) < 0.005, 6000);
check("talking again lowers your new volume (0.5 → 0.15)", Math.abs((await vid(hp)).vol - 0.15) < 0.005, String((await vid(hp)).vol));
await hp.locator('.np-round[aria-label="Leave voice"]').click();
await sleep(300);
check("leaving voice while lowered: exactly your volume again (0.5)", (await vid(hp)).vol === 0.5, String((await vid(hp)).vol));
await sleep(1500);
check("…and nothing changes it after you've left voice", (await vid(hp)).vol === 0.5);
await H.sw.evaluate(() => chrome.storage.sync.set({ autoDuck: false }));
await hp.locator(".np-join-voice").click();
await sleep(4000);
check("auto-duck off: the volume stays put while they talk", (await vid(hp)).vol === 0.5 && !!(await sh(hp, (r) => [...r.querySelectorAll(".np-person.np-speaking")].length)));
await hp.locator('.np-round[aria-label="Leave voice"]').click();
await gp.locator('.np-round[aria-label="Leave voice"]').click();
await H.sw.evaluate(() => chrome.storage.sync.remove("autoDuck"));

// ================================================================ 4. pause on drop
await hp.evaluate(() => document.querySelector("#v").play());
await sleep(2500);
check("playing before the drop", !(await vid(hp)).paused && !(await vid(gp)).paused);
await pp.reload(); // a dropped connection that comes back within the grace period
const dropTxt = await until(() => holdText(hp), 8000);
check("a member drops: 'Priya Sharma disconnected, paused' and everyone pauses", dropTxt === "Priya Sharma disconnected, paused" && (await until(async () => (await vid(gp)).paused && (await vid(hp)).paused, 4000)), String(dropTxt));
check("…the guest sees it too", (await holdText(gp)) === "Priya Sharma disconnected, paused");
await hp.screenshot({ path: "c3-drop-dark.png" });
check("they're back within the grace period: playing again on its own", !!(await until(async () => !(await vid(hp)).paused && !(await vid(gp)).paused && (await holdText(hp)) === null, 15000)), String(await holdText(hp)));
await until(async () => !(await vid(pp)).paused, 8000);
await sleep(1500);
const [d1, d2, d3] = [await vid(hp), await vid(gp), await vid(pp)];
check("…all three in sync", Math.abs(d1.t - d2.t) < 1.2 && Math.abs(d1.t - d3.t) < 1.5, `${d1.t.toFixed(1)} ${d2.t.toFixed(1)} ${d3.t.toFixed(1)}`);
// a clean Leave never pauses
// gone for good: after the grace period a Resume button (any controller)
await pp.close();
check("gone (tab closed): paused with 'disconnected'", !!(await until(async () => (await holdText(gp)) === "Priya Sharma disconnected, paused" && (await vid(gp)).paused, 8000)));
const left = await until(async () => ((await holdText(gp)) === "Priya Sharma left. Press Resume to play on." ? true : null), 25000);
check("after the grace period: 'Priya Sharma left. Press Resume to play on.'", !!left, String(await holdText(gp)));
check("…with a Resume button", await gp.locator(".np-hold-btn").isVisible());
check("…still paused until someone presses it", (await vid(hp)).paused && (await vid(gp)).paused);
await gp.screenshot({ path: "c3-resume-light.png" });
await gp.locator(".np-hold-btn").click();
check("Resume (pressed by a guest): everyone plays", !!(await until(async () => !(await vid(hp)).paused && !(await vid(gp)).paused && (await holdText(hp)) === null, 6000)));
// switched off
await H.sw.evaluate(() => chrome.storage.sync.set({ dropPause: false }));
await sleep(500);
await gp.reload();
await sleep(2500);
check("'Pause when someone drops out' off: no pause", !(await vid(hp)).paused && (await holdText(hp)) === null);
await H.sw.evaluate(() => chrome.storage.sync.remove("dropPause"));
await until(async () => (await people(gp)).length >= 4, 15000);

// ================================================================ a 2.0.2 browser joins late
const O2 = await launch("pw-c3o2", { name: "Older", avatar: "🦕", extra: { serverUrl: T.url }, ext: OLD20 });
const o2 = await O2.ctx.newPage();
watch(o2, "old20");
await o2.goto(created.invite);
await Promise.all([o2.waitForNavigation(), o2.click("a.btn")]);
await until(async () => (await people(o2)).length >= 4, 20000);
await sleep(3000);
const l20 = await lines(o2), lH = await lines(hp);
check(`${ver(OLD20)} replays the history: same lines as 2.2, no garbage (edits, deletes, signals and pins are dropped)`, l20.length === lH.length && l20.every((l) => (l.text || l.gif) && !/"t":|\[object|undefined/.test(l.text)), `${l20.length} vs ${lH.length}`);
check(`${ver(OLD20)}: spoilers read '[spoiler]'`, l20.some((l) => l.text === "the killer is [spoiler] lol") && !l20.some((l) => /butler|everyone dies/.test(l.text)));
check(`${ver(OLD20)}: no 'can't decrypt' warning`, !(await sh(o2, (r) => [...r.querySelectorAll(".np-sys")].some((n) => /decrypt/i.test(n.textContent)))));
await O2.ctx.close();

// ================================================================ what the server saw
const secret = ["Chirag", "Rahul", "Priya", "Sharma", "Bottie", "Oldie", "Older", "ORIG pizza", "the butler", "killer", "everyone dies", "look at this", "typo mesage", "typo message", "delete me", "pin then delete", "no way", "HACKED", "helxxxxx", KEY];
check("tap saw the traffic", T.frames.filter((f) => /"type":"(ev|pin|chat)"/.test(f.text)).length >= 40, String(T.frames.length));
check("no WebSocket frame contains a name, message, spoiler, mention or pin text", leaks(T.frames, secret).length === 0, JSON.stringify(leaks(T.frames, secret)));
check("no plaintext 2.2 fields in any frame", !T.frames.some((f) => /"(text|t|ty|ids|mn|sp|s|re|name|uid|why|on)":/.test(f.text)), T.frames.find((f) => /"(text|t|ty|ids|mn|sp|s|re|name|uid|why|on)":/.test(f.text))?.text.slice(0, 160));
const srvLog = fs.readFileSync(SERVER_LOG, "utf8");
check("server log has none of it either", leaks([{ text: srvLog }], secret).length === 0);
check("no site hotkeys fired while typing", (await hot(hp)) === hot0.h, JSON.stringify([await hot(hp), hot0.h]));
// the 2.1.0 / 2.0.2 builds' page.js calls video.play() without a catch, so a party pause landing during that play()
// is an unhandled rejection on the old clients' pages (2.2 catches it); every other error counts, on every page
const oldPlayRace = (e) => /^old(20)?: The play\(\) request was interrupted by a call to pause\(\)/.test(e);
const realErrors = errors.filter((e) => !oldPlayRace(e));
if (realErrors.length !== errors.length) out("ignored on the old clients (fixed in 2.2):", errors.filter(oldPlayRace).join(" | "));
check("no script errors on the pages", realErrors.length === 0, realErrors.join(" | "));
bot.close();
T.close();
const f = summary("CHAT 2.2");
for (const x of [H, G, P, O]) await x.ctx.close();
process.exit(f ? 1 : 0);
