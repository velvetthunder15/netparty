// chat scroll: after the chat is hidden and shown again it shows the newest message (or where you scrolled to)
import { launch, shadow, until, people, check, summary, out, sleep } from "./lib.mjs";
const SITE = "https://www.netflix.com/watch/12345";
const H = await launch("/tmp/pw-sh", { name: "Chirag", avatar: "🦊" });
const G = await launch("/tmp/pw-sg", { name: "Rahul", avatar: "🐼" });
const hp = await H.ctx.newPage(), gp = await G.ctx.newPage();
const errors = [];
for (const [p, n] of [[hp, "host"], [gp, "guest"]]) p.on("pageerror", (e) => errors.push(n + ": " + e.message));
await hp.goto(SITE); await hp.waitForTimeout(2000);
const created = await H.sw.evaluate(async (url) => { const [t] = await chrome.tabs.query({ url: url + "*" }); return chrome.tabs.sendMessage(t.id, { cmd: "create" }); }, SITE);
await gp.goto(created.invite);
await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
check("guest joined", !!(await until(async () => (await people(gp)).length === 2, 20000)));
const closeP = async (p) => { await p.locator('button[aria-label="Hide chat (Esc)"]').click(); await sleep(300); };
const openP = async (p) => { await p.locator(".np-toggle").click(); await sleep(500); };
const send = async (p, t) => { await p.locator(".np-input").click(); await p.keyboard.type(t); await p.keyboard.press("Enter"); };
const pos = (p) => shadow(p, (r) => { const c = r.querySelector(".np-chat"); return { gap: Math.round(c.scrollHeight - c.scrollTop - c.clientHeight), top: Math.round(c.scrollTop), h: c.clientHeight, last: c.lastElementChild?.textContent || "" }; });
for (let i = 1; i <= 30; i++) { await send(gp, "line " + i); await sleep(380); }
check("host got 30 lines", !!(await until(async () => (await pos(hp)).last.includes("line 30"), 15000)));
let p0 = await pos(hp);
check("host chat at the newest line", p0.gap < 5 && p0.top > 100, JSON.stringify(p0));
// close the panel, more lines arrive, reopen
await closeP(hp);
for (let i = 31; i <= 34; i++) { await send(gp, "line " + i); await sleep(400); }
await sleep(800);
await openP(hp);
p0 = await pos(hp);
check("reopened panel shows the newest line (line 34)", p0.gap < 5 && p0.last.includes("line 34") && p0.h > 0, JSON.stringify(p0));
// close and reopen with nothing new
await closeP(hp); await openP(hp);
p0 = await pos(hp);
check("close + reopen keeps the newest line in view", p0.gap < 5, JSON.stringify(p0));
// scrolled up: reopening returns to where they were
await shadow(hp, (r) => { const c = r.querySelector(".np-chat"); c.scrollTop = 120; c.dispatchEvent(new Event("scroll")); });
await sleep(200);
await closeP(hp); await openP(hp);
p0 = await pos(hp);
check("scrolled-up reader comes back to the same spot", Math.abs(p0.top - 120) < 3, JSON.stringify(p0));
// back to bottom, then switch to another tab and back
await shadow(hp, (r) => { const c = r.querySelector(".np-chat"); c.scrollTop = c.scrollHeight; c.dispatchEvent(new Event("scroll")); });
const other = await H.ctx.newPage(); await other.goto("about:blank"); await other.bringToFront();
await send(gp, "while away"); await sleep(1200);
await hp.bringToFront(); await sleep(500);
p0 = await pos(hp);
check("after switching tabs, the newest line is in view", p0.gap < 5 && p0.last.includes("while away"), JSON.stringify(p0));
// click on the video (elsewhere on the page) and back into the chat
await hp.mouse.click(300, 300); await sleep(300);
await hp.locator(".np-input").click(); await sleep(300);
p0 = await pos(hp);
check("clicking the video and back keeps the newest line", p0.gap < 5, JSON.stringify(p0));
// reload with panel closed, then open: history replayed while hidden
await closeP(hp);
await hp.reload(); await sleep(4000);
await openP(hp); await sleep(300);
p0 = await pos(hp);
check("after reload with the chat closed, opening shows the newest line", p0.gap < 5 && p0.h > 0 && p0.top > 100, JSON.stringify(p0));
check("no page errors", errors.length === 0, errors.join(" | "));
summary();
await H.ctx.close(); await G.ctx.close();
process.exit(0);
