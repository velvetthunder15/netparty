// Core flow e2e (fake Netflix, or SITE=<JioHotstar watch URL>): split-screen layout, start party
// → invite page (key in the #fragment, host named by the page itself) → join → chat via Enter
// and Send, both ways → pause/seek sync → reloads (seats, host role and decrypted history survive).
// Everything goes through a recording proxy: no chat text or name may reach the server.
import { launch, shadow, until, people, check, summary, out, sleep, tap, leaks, keyOf } from "./lib.mjs";
const SITE = process.env.SITE || "https://www.netflix.com/watch/12345";
const T = tap(8791, 8787);

const H = await launch("/tmp/pw-host", { name: "Chirag", extra: { serverUrl: T.url } });
const G = await launch("/tmp/pw-guest", { name: "Rahul", extra: { serverUrl: T.url } });
const errors = [];
const hp = await H.ctx.newPage();
const gp = await G.ctx.newPage();
for (const [p, n] of [[hp, "host"], [gp, "guest"]]) {
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  if (process.env.DEBUG) p.on("console", (m) => out(n + " console:", m.text().slice(0, 200)));
}
await hp.goto(SITE);
await hp.waitForTimeout(2500);
const created = await H.sw.evaluate(async (url) => {
  const [t] = await chrome.tabs.query({ url: url.split("?")[0] + "*" });
  return chrome.tabs.sendMessage(t.id, { cmd: "create" });
}, SITE);
out("create ->", JSON.stringify(created).replace(/#k=[\w-]+/, "#k=<key>"));
const KEY = keyOf(created?.invite);
check("party created, invite link has the key in its #fragment", !!KEY, JSON.stringify(created));
if (!KEY) process.exit(1);
const ROOM = created.invite.match(/\/j\/([a-z0-9]+)/)[1];

// guest follows the invite link exactly like a friend would
await gp.goto(created.invite);
const h1 = await until(async () => { const t = (await gp.textContent("h1")).trim(); return /^Chirag invited you/.test(t) && t; }, 5000);
check("invite page: 'Chirag invited you' (name decrypted in the page)", !!h1, await gp.textContent("h1"));
await gp.screenshot({ path: "invite.png" });
const href = await gp.getAttribute("a.btn", "href");
check("Join link = watch page + key in its #fragment", href.endsWith(`npParty=${ROOM}#npKey=${KEY}`), href);
await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
out("guest landed on", gp.url());
check("guest joined", !!(await until(async () => (await people(gp)).length >= 2, 20000)));
check("key removed from the guest's address bar", !gp.url().includes("npKey") && !gp.url().includes(KEY), gp.url());
out("host members:", JSON.stringify(await people(hp)));
const gSys = await shadow(gp, (r) => { return [...r.querySelectorAll(".np-sys")].map((n) => n.textContent); });
out("guest sys:", JSON.stringify(gSys));
check("guest sees the encryption note and 'You joined'", gSys.some((t) => /end-to-end encrypted/.test(t)) && gSys.includes("You joined the party."), JSON.stringify(gSys));
const hSys = await until(() => shadow(hp, (r) => { const t = [...r.querySelectorAll(".np-sys")].map((n) => n.textContent); return t.includes("Rahul joined") && t; }), 5000);
check("host sees 'Rahul joined' (rendered from the decrypted profile)", !!hSys, JSON.stringify(await shadow(hp, (r) => { return [...r.querySelectorAll(".np-sys")].map((n) => n.textContent); })));
const layout = async (p) => p.evaluate(() => {
  const r = (q) => document.querySelector(q).getBoundingClientRect();
  const panel = document.getElementById("netparty-root").shadowRoot.querySelector(".np-panel").getBoundingClientRect();
  return { vw: innerWidth, videoW: Math.round(r("video").width), boxW: Math.round(r("[data-np-shrink]").width), videoRight: Math.round(r("video").right), fsRight: Math.round(r("#fsbtn").right), panelLeft: Math.round(panel.left), panelW: Math.round(panel.width), docked: document.documentElement.classList.contains("np-docked") };
});
const L = await layout(gp);
out("guest layout (docked):", JSON.stringify(L));
check("docked: video and controls end where the chat begins", L.docked && L.videoRight <= L.panelLeft + 1 && L.fsRight <= L.panelLeft + 1, JSON.stringify(L));
const gMembers = await people(gp);
check("guest sees both names", JSON.stringify(gMembers) === JSON.stringify(["Chirag", "You"]), JSON.stringify(gMembers));

// chat: type + Enter on guest, check host gets it; page hotkeys must not eat Enter
const bubbles = (p) => shadow(p, (r) => { return [...r.querySelectorAll(".np-bubble")].map((n) => n.firstChild.textContent); });
await gp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-input").focus());
await gp.keyboard.type("hello from rahul MARKER-run-1");
await gp.keyboard.press("Enter");
check("host receives the guest's message (Enter)", !!(await until(async () => (await bubbles(hp)).includes("hello from rahul MARKER-run-1"))), JSON.stringify(await bubbles(hp)));
check("message shows the guest's name on the host", (await shadow(hp, (r) => { return [...r.querySelectorAll(".np-author")].map((n) => n.textContent); })).includes("Rahul"));
check("page hotkeys not triggered on guest", (await gp.evaluate(() => window.__hotkeys)) === 0);
await hp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-input").focus());
await hp.keyboard.type("hey rahul, button test");
await hp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-send").click());
check("guest receives the host's message (Send button)", !!(await until(async () => (await bubbles(gp)).includes("hey rahul, button test"))), JSON.stringify(await bubbles(gp)));

// playback sync
await hp.evaluate(() => document.querySelector("video").pause());
check("guest paused after host pause", !!(await until(() => gp.evaluate(() => document.querySelector("video").paused), 5000)));
await hp.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 60; v.play(); });
await sleep(2500);
const [ht, gt] = [await hp.evaluate(() => document.querySelector("video").currentTime), await gp.evaluate(() => document.querySelector("video").currentTime)];
const gPlaying = !(await gp.evaluate(() => document.querySelector("video").paused));
check("host seek to 60 s + play → guest follows", gPlaying && Math.abs(ht - gt) < 1.5, `host ${ht.toFixed(1)} guest ${gt.toFixed(1)}`);
const hostSys = await shadow(gp, (r) => { return [...r.querySelectorAll(".np-sys")].map((n) => n.textContent); });
check("playback notes name the host ('Chirag paused')", hostSys.some((t) => /^Chirag (paused|played|jumped)/.test(t)), JSON.stringify(hostSys.slice(-4)));
await hp.screenshot({ path: "host-panel.png" });

// reloads: guest reloads, then host reloads; decrypted history, seats and host role must survive
const shot = (p) => shadow(p, (r) => { return { people: [...r.querySelectorAll(".np-pname")].map((n) => n.textContent), crown: r.querySelectorAll(".np-crown").length, msgs: [...r.querySelectorAll(".np-bubble")].map((n) => n.firstChild.textContent), authors: [...r.querySelectorAll(".np-author")].map((n) => n.textContent), sys: [...r.querySelectorAll(".np-sys")].map((n) => n.textContent) }; });
const histOk = (s) => s && s.msgs.includes("hello from rahul MARKER-run-1") && s.msgs.includes("hey rahul, button test") && s.people.length === 2;
await gp.reload();
const gs = await until(async () => { const s = await shot(gp); return histOk(s) && s; }, 15000);
out("guest after reload:", JSON.stringify(gs || (await shot(gp))));
check("guest reload: seat kept, history decrypted again", !!gs && gs.authors.includes("Chirag"));
await hp.reload();
const hs = await until(async () => { const s = await shot(hp); return histOk(s) && s; }, 15000);
out("host after reload:", JSON.stringify(hs || (await shot(hp))));
check("host reload: history decrypted again, own messages still 'mine'", !!hs && (await shadow(hp, (r) => { return [...r.querySelectorAll(".np-mine .np-bubble")].map((n) => n.firstChild.textContent); })).includes("hey rahul, button test"));
const crownName = await hp.evaluate(() => { const r = document.getElementById("netparty-root").shadowRoot; const c = r.querySelector(".np-crown"); return c && c.closest(".np-person")?.querySelector(".np-pname")?.textContent; });
check("host still host", crownName === "You", String(crownName));
const jl = (await shot(gp)).sys.filter((t) => / (joined|left)$/.test(t)).sort();
check("guest saw no left/joined spam from the reloads", JSON.stringify(jl) === JSON.stringify(["Chirag joined", "Rahul joined"]), JSON.stringify(jl));
await sleep(3000); // let the reloaded player settle (remote actions are applied for ~2 s after a rejoin)
await hp.evaluate(() => document.querySelector("video").pause());
check("sync after reloads (guest paused)", !!(await until(() => gp.evaluate(() => document.querySelector("video").paused), 5000)));
await shadow(gp, (r) => { r.querySelector(".np-close").click(); });
const L2f = () => gp.evaluate(() => ({ vw: innerWidth, videoRight: Math.round(document.querySelector("video").getBoundingClientRect().right), docked: document.documentElement.classList.contains("np-docked") }));
const L2 = (await until(async () => { const l = await L2f(); return !l.docked && l.videoRight === l.vw && l; }, 3000)) || (await L2f());
check("chat hidden: video back to full width", !L2.docked && L2.videoRight === L2.vw, JSON.stringify(L2));
await hp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-input").focus());
await hp.keyboard.type("toast test");
await hp.keyboard.press("Enter");
const toastTxt = await until(() => shadow(gp, (r) => { const t = r.querySelector(".np-toast.np-show"); return t && t.textContent; }), 4000);
check("toast with name + text while the chat is hidden", toastTxt === "Chirag toast test", String(toastTxt));
await gp.screenshot({ path: "guest-closed.png" });

// popup render (in party) for the host
const extId = H.sw.url().split("/")[2];
const pop = await H.ctx.newPage();
await pop.setViewportSize({ width: 320, height: 520 });
await hp.bringToFront();
await pop.goto(`chrome-extension://${extId}/popup.html`);
await pop.waitForTimeout(800);
await pop.screenshot({ path: "popup.png" });
const copyLink = await pop.evaluate(() => document.getElementById("copy").dataset.link);
check("popup's Copy invite link includes the key", copyLink === created.invite, String(copyLink).replace(/#k=.*/, "#k=…"));

// the server saw ciphertext only
const secret = ["Chirag", "Rahul", "hello from rahul", "MARKER-run", "button test", "toast test", KEY];
check("no WebSocket frame contains names, messages or the key", leaks(T.frames, secret).length === 0, JSON.stringify(leaks(T.frames, secret)));
check("no plaintext fields in any frame", !T.frames.some((f) => /"(name|text|avatar|byName)":/.test(f.text)));
check("no script errors on the pages", errors.length === 0, errors.join(" | "));
const f = summary("CORE");
T.close();
await H.ctx.close();
await G.ctx.close();
process.exit(f ? 1 : 0);
