// "Sync any video" (2.0) e2e in Chromium: two browsers (host + guest) on local test pages (anysite.mjs,
// http://localhost:8450 and a second origin on :8451).
//
// activeTab can't be granted in an automated browser (it needs a real click on the toolbar icon), so this
// suite loads a TEST COPY of the extension whose manifest also lists http://localhost:8450/* and :8451/* in
// host_permissions (as http://localhost/*). That stands in for the activeTab grant: the popup's own code (popup.html opened in a
// tab, as the other suites do) then injects the scripts with chrome.scripting exactly as it does for a user,
// and chrome.permissions.request() resolves true at once (already granted), standing in for the browser's
// prompt. A refused prompt is simulated by stubbing chrome.permissions.request in the popup page.
//
// Covers: popup "Sync this tab" → party; invite page (encrypted page address decrypted in the page, strict
// http(s) check, never in the HTML); "Open the video" → guest popup "Join party on this tab"; play / pause /
// seek / speed sync both ways within 1 s; drift correction by speed nudges and by a hard seek; the site
// swapping the <video> mid-play; Theater mode; open shadow root; same-origin iframe; cross-origin iframe
// (Allow + refused); two videos (picker); duration mismatch → "Open host's page"; live stream (play/pause
// only); canvas-only page; "Always allow on this site" (registered script, reload keeps the party);
// leak audit of every WebSocket frame.
import fs from "node:fs";
import { launch, shadow, until, people, check, summary, out, sleep, tap, leaks, keyOf, EXT, SERVER } from "./lib.mjs";
import { start as startPages } from "./anysite.mjs";
import { WebSocket } from "/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/server/node_modules/ws/wrapper.mjs";

const A = "http://localhost:8450";
const TEST_EXT = "/tmp/np-ext-anytest";
fs.rmSync(TEST_EXT, { recursive: true, force: true });
fs.cpSync(EXT, TEST_EXT, { recursive: true });
const man = JSON.parse(fs.readFileSync(TEST_EXT + "/manifest.json", "utf8"));
man.host_permissions.push("http://localhost/*"); // both test origins (:8450, :8451); match patterns cover every port
fs.writeFileSync(TEST_EXT + "/manifest.json", JSON.stringify(man, null, 2));

const stopPages = startPages();
const T = tap(8793, 8787);
const H = await launch("/tmp/pw-any-host", { name: "Chirag", ext: TEST_EXT, extra: { serverUrl: T.url } });
const G = await launch("/tmp/pw-any-guest", { name: "Rahul", ext: TEST_EXT, extra: { serverUrl: T.url } });
const errors = [];
const watch = (p, n) => {
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  if (process.env.DEBUG) p.on("console", (m) => out(n + " console:", m.text().slice(0, 200)));
};
const extId = (x) => x.sw.url().split("/")[2];
const FILES = ["any-mode.js", "early.js", "emoji-data.js", "anyvideo.js", "content.js"];

// ---- helpers
async function openPopup(x, page) {
  const pop = await x.ctx.newPage();
  await pop.setViewportSize({ width: 320, height: 640 });
  await page.bringToFront();
  await pop.goto(`chrome-extension://${extId(x)}/popup.html`);
  await pop.waitForTimeout(900);
  return pop;
}
const visible = (pop, id) => pop.evaluate((i) => !document.getElementById(i).classList.contains("hidden"), id);
// what the popup's "Sync this tab" does (inject after a click), for the scenarios that don't re-test the popup
const inject = (x, page) =>
  x.sw.evaluate(
    async ([u, files]) => {
      const t = (await chrome.tabs.query({})).find((t) => t.url === u);
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files });
      for (let i = 0; i < 40; i++) {
        const s = await chrome.tabs.sendMessage(t.id, { cmd: "status" }, { frameId: 0 }).catch(() => null);
        if (s?.booted) return true;
        await new Promise((r) => setTimeout(r, 150));
      }
      return false;
    },
    [page.url(), FILES],
  );
const cmd = (x, page, msg) =>
  x.sw.evaluate(
    async ([u, m]) => {
      const t = (await chrome.tabs.query({})).find((t) => t.url === u);
      if (!t) return { error: "no tab " + u };
      return chrome.tabs.sendMessage(t.id, m, { frameId: 0 }).catch((e) => ({ error: String(e) }));
    },
    [page.url(), msg],
  );
const vt = (ctx) => ctx.evaluate(() => window.__v().currentTime);
const vpaused = (ctx) => ctx.evaluate(() => window.__v().paused);
const vrate = (ctx) => ctx.evaluate(() => window.__v().playbackRate);
const gap = async (a, b) => Math.abs((await vt(a)) - (await vt(b)));
async function syncChecks(label, hc, gc, { seek = true } = {}) {
  await hc.evaluate(() => window.__v().play());
  await until(async () => !(await vpaused(gc)), 5000);
  await sleep(2200);
  await hc.evaluate(() => window.__v().pause());
  check(`${label}: host pause → guest paused`, !!(await until(() => vpaused(gc), 4000)));
  if (seek) {
    await sleep(2200);
    await hc.evaluate(() => (window.__v().currentTime = 30));
    const ok = await until(async () => Math.abs((await vt(gc)) - 30) < 1, 4000, 100);
    check(`${label}: host seek to 30 s → guest within 1 s`, !!ok, `guest ${(await vt(gc)).toFixed(2)}`);
  }
  await sleep(2200);
  await hc.evaluate(() => window.__v().play());
  check(`${label}: host play → guest plays`, !!(await until(async () => !(await vpaused(gc)), 4000)));
  if (seek) {
    await sleep(2500);
    const g1 = await gap(hc, gc);
    check(`${label}: playing in sync (gap < 1 s)`, g1 < 1, `gap ${g1.toFixed(2)} s`);
    // the guest drives too
    await gc.evaluate(() => (window.__v().currentTime = 55));
    const ok = await until(async () => Math.abs((await vt(hc)) - (await vt(gc))) < 1 && (await vt(hc)) > 54, 5000, 100);
    check(`${label}: guest seek to 55 s → host follows within 1 s`, !!ok, `host ${(await vt(hc)).toFixed(2)} guest ${(await vt(gc)).toFixed(2)}`);
  }
}
const panelSys = (p) => shadow(p, (r) => { return [...r.querySelectorAll(".np-sys")].map((n) => n.textContent); });
const anyNote = (p) => shadow(p, (r) => { const n = r.querySelector(".np-any-note"); return n && !n.hidden ? n.textContent : ""; });
async function endParty(x, page) {
  await cmd(x, page, { cmd: "leave" });
  await sleep(500);
}

const hp = await H.ctx.newPage();
const gp = await G.ctx.newPage();
watch(hp, "host");
watch(gp, "guest");

// ================================================================ 1. plain page, through the popup
await hp.goto(A + "/plain");
await hp.waitForTimeout(1200);
let pop = await openPopup(H, hp);
check("popup on a non-supported page: shows Sync this tab", (await visible(pop, "vAny")) && (await pop.textContent("#anyStart")) === "Sync this tab" && (await visible(pop, "anyAlwaysRow")));
check("NetParty isn't running on the page before the click", !(await hp.evaluate(() => !!document.getElementById("netparty-root"))) && (await cmd(H, hp, { cmd: "status" })).error);
await pop.click("#anyStart");
const inParty = await until(() => pop.evaluate(() => !document.getElementById("vParty").classList.contains("hidden") && document.getElementById("copy").dataset.link), 12000);
check("Sync this tab → party started, invite link with key", !!inParty && !!keyOf(inParty), String(inParty).replace(/#k=.*/, "#k=…"));
await pop.screenshot({ path: "any-popup-party.png" });
await pop.close();
const INVITE = inParty;
const ROOM = INVITE.match(/\/j\/([a-z0-9]+)/)[1];
check("host's panel is up on the page", !!(await until(() => shadow(hp, (r) => { return !!r.querySelector(".np-open"); }), 5000)));
await hp.screenshot({ path: "any-host.png" });

// invite page: the page address is encrypted; the page decrypts it and links it, the HTML never holds it
const html = await (await fetch(INVITE.replace("ws://", "http://").split("#")[0])).text();
check("invite page HTML: Open the video, address not in plaintext", /Open the video/.test(html) && !html.includes("8450") && !html.includes("/plain"), "");
await gp.goto(INVITE);
const go = await until(() => gp.evaluate(() => { const b = document.getElementById("go"); return b && !b.hidden && { href: b.href, text: b.textContent, target: b.target, rel: b.rel, site: document.getElementById("site")?.textContent, steps: !document.querySelector("[data-any-step]").hidden, h1: document.querySelector("h1").textContent }; }), 5000);
out("invite page:", JSON.stringify(go));
check("invite page: Open the video → the host's page (decrypted in the page)", go?.href === A + "/plain" && go.text === "Open the video" && go.target === "_blank" && /noopener/.test(go.rel) && /noreferrer/.test(go.rel), JSON.stringify(go));
check("invite page: names the site and the host, shows the steps", go?.site === "localhost" && /^Chirag invited you/.test(go?.h1 || "") && go?.steps);
await gp.screenshot({ path: "any-invite.png" });
const [gp2] = await Promise.all([G.ctx.waitForEvent("page"), gp.click("#go")]);
watch(gp2, "guest");
await gp2.waitForLoadState();
await gp2.waitForTimeout(1200);
check("Open the video opened the host's page in a new tab", gp2.url() === A + "/plain", gp2.url());
pop = await openPopup(G, gp2);
const joinBox = await pop.evaluate(() => ({ shown: !document.getElementById("anyJoinBox").classList.contains("hidden"), hint: document.getElementById("anyJoinHint").textContent, label: document.getElementById("anyJoin").textContent }));
check("guest popup: Join party on this tab (found the open invite)", joinBox.shown && joinBox.label === "Join party on this tab" && joinBox.hint.includes(ROOM), JSON.stringify(joinBox));
await pop.screenshot({ path: "any-popup-join.png" });
await pop.click("#anyJoin");
check("guest joined from the popup", !!(await until(async () => (await people(gp2))?.length === 2, 15000)), JSON.stringify(await people(gp2)));
await pop.close();
check("host sees the guest", !!(await until(async () => JSON.stringify(await people(hp)) === '["You","Rahul"]', 8000)));
check("guest: no mismatch note (same video)", (await anyNote(gp2)) === "", await anyNote(gp2));

await syncChecks("plain", hp, gp2);

// speed
await sleep(2200);
await hp.evaluate(() => (window.__v().playbackRate = 1.5));
const r15 = await until(async () => Math.abs((await vrate(gp2)) - 1.5) < 0.2 && (await vrate(gp2)), 4000);
check("host speed 1.5x → guest plays at ~1.5x", !!r15, String(await vrate(gp2)));
check("speed change named in the guest's chat", !!(await until(async () => (await panelSys(gp2)).some((t) => t === "Chirag set the speed to 1.5x"), 3000)), JSON.stringify((await panelSys(gp2)).slice(-3)));
await sleep(3000);
const g15 = await gap(hp, gp2);
check("in sync at 1.5x (gap < 1 s)", g15 < 1, g15.toFixed(2));
await hp.evaluate(() => (window.__v().playbackRate = 1));
check("back to 1x on the guest", !!(await until(async () => Math.abs((await vrate(gp2)) - 1) < 0.15, 4000)));

// drift: move the guest's video without NetParty seeing the event → speed nudges close the gap
await sleep(4000);
await gp2.evaluate(() => {
  window.__stop = (e) => e.stopPropagation();
  for (const t of ["seeked", "seeking"]) window.addEventListener(t, window.__stop, true);
  window.__v().currentTime -= 0.9;
});
const nudgeSeen = await until(async () => (await vrate(gp2)) > 1.01 && (await vrate(gp2)), 5000, 100);
check("small drift (0.9 s behind) → guest plays a little faster", !!nudgeSeen && nudgeSeen <= 1.13, String(nudgeSeen));
const closed = await until(async () => (await gap(hp, gp2)) < 0.3 && Math.abs((await vrate(gp2)) - 1) < 0.001, 20000, 250);
check("…gap closed (< 0.3 s) and speed back to 1x, no seek", !!closed, `gap ${(await gap(hp, gp2)).toFixed(2)} rate ${await vrate(gp2)}`);
check("the host never saw the guest's nudges (host still 1x)", (await vrate(hp)) === 1);
await gp2.evaluate(() => (window.__v().currentTime -= 6));
const hard = await until(async () => (await gap(hp, gp2)) < 1, 6000, 200);
check("big drift (6 s) → hard seek back into sync", !!hard, (await gap(hp, gp2)).toFixed(2));
await gp2.evaluate(() => { for (const t of ["seeked", "seeking"]) window.removeEventListener(t, window.__stop, true); });

// the site swaps the <video> element mid-play (ad, next episode): NetParty follows the new one
await sleep(2500);
await hp.evaluate(() => window.__swap());
await sleep(2500);
await hp.evaluate(() => window.__v().pause());
check("host's <video> replaced → pause on the new element still syncs", !!(await until(() => vpaused(gp2), 4000)));
await sleep(2200);
await gp2.evaluate(() => window.__swap());
await sleep(2500);
await hp.evaluate(() => { window.__v().currentTime = 70; window.__v().play(); });
check("guest's <video> replaced → it follows the host's seek + play", !!(await until(async () => !(await vpaused(gp2)) && Math.abs((await vt(gp2)) - (await vt(hp))) < 1, 5000)), `h ${(await vt(hp)).toFixed(1)} g ${(await vt(gp2)).toFixed(1)}`);

// Theater mode
const before = await hp.evaluate(() => { const r = window.__v().getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); });
const tip = await shadow(hp, (r) => { const b = r.querySelector(".np-theater"); b.click(); return b.title; });
check("Theater button explains native fullscreen hides the chat", /fullscreen button hides the chat/.test(tip || ""), tip);
await sleep(400);
const th = await hp.evaluate(() => {
  const v = window.__v().getBoundingClientRect();
  const p = document.getElementById("netparty-root").shadowRoot.querySelector(".np-panel").getBoundingClientRect();
  return { vw: innerWidth, vh: innerHeight, v: [v.left, v.top, v.width, v.height].map(Math.round), panelLeft: Math.round(p.left), panelW: Math.round(p.width) };
});
out("theater:", JSON.stringify(th));
check("Theater: video fills the window left of the chat, chat still visible", th.v[0] === 0 && th.v[1] === 0 && Math.abs(th.v[2] - th.panelLeft) <= 1 && th.v[3] === th.vh && th.panelW > 250 && th.panelLeft + th.panelW === th.vw, JSON.stringify(th));
await hp.screenshot({ path: "any-theater.png" });
await shadow(hp, (r) => { r.querySelector(".np-theater").click(); });
await sleep(300);
const after = await hp.evaluate(() => { const r = window.__v().getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); });
check("Theater off: video back where it was", JSON.stringify(after) === JSON.stringify(before), JSON.stringify([before, after]));

// "Always allow on this site": registered script; a reload keeps the party
pop = await openPopup(H, hp);
await pop.click("#anyAlways");
const allowMsg = await until(() => pop.evaluate(() => document.getElementById("anyMsg").textContent), 4000);
check("Always allow: popup confirms", /starts on this site by itself/.test(allowMsg || ""), allowMsg);
await pop.close();
const regs = await H.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id + " " + s.matches.join(",")));
check("Always allow: content scripts registered for that site only", regs.length === 2 && regs.every((r) => r.startsWith("npany-") && r.endsWith(" http://localhost/*")), JSON.stringify(regs));
await hp.reload();
check("host reload on an allowed site: NetParty comes back and rejoins as host", !!(await until(async () => JSON.stringify(await people(hp)) === '["You","Rahul"]', 15000)), JSON.stringify(await people(hp)));
await sleep(3000);
await hp.evaluate(() => window.__v().pause());
check("sync after the host's reload", !!(await until(() => vpaused(gp2), 5000)));
pop = await openPopup(H, hp);
check("popup (allowed site, in party) shows the party and the ticked box", (await visible(pop, "vParty")) && (await pop.evaluate(() => document.getElementById("anyAlways").checked)));
await pop.click("#anyAlways");
await sleep(500);
await pop.close();
const regs2 = await H.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
check("unticking removes the registered scripts", regs2 === 0, String(regs2));

// leak audit for scenario 1
const secret = ["Chirag", "Rahul", "/plain", "localhost:8450", keyOf(INVITE)];
check("no WebSocket frame contains names, the page address or the key", leaks(T.frames, secret).length === 0, JSON.stringify(leaks(T.frames, secret)));
check("the server got the page only as ciphertext", T.frames.some((f) => f.dir === "up" && /"type":"page","reqId":\d+,"data":\{"ct":"[A-Za-z0-9_-]+"\}/.test(f.text)));
await endParty(H, hp);
await gp.close();

// ================================================================ 2.-4. shadow root, same-origin iframe
async function scenario(path, label, { hctx = (p) => p, gctx = (p) => p } = {}) {
  await hp.goto(A + path);
  await gp2.goto(A + path);
  await sleep(1500);
  await inject(H, hp);
  const c = await cmd(H, hp, { cmd: "create" });
  check(`${label}: party started (video found)`, !!keyOf(c.invite), JSON.stringify(c).replace(/#k=[\w-]+/, "#k=…"));
  if (!c.invite) return null;
  await inject(G, gp2);
  const room = c.invite.match(/\/j\/([a-z0-9]+)/)[1];
  const j = await cmd(G, gp2, { cmd: "join", roomId: room, key: keyOf(c.invite) });
  check(`${label}: guest joined`, j.ok && !!(await until(async () => (await people(gp2))?.length === 2, 10000)), JSON.stringify(j));
  await syncChecks(label, hctx(hp), gctx(gp2));
  await endParty(H, hp);
  return c;
}
await scenario("/shadow", "shadow DOM");
await scenario("/iframe", "same-origin iframe");

// ================================================================ 5. cross-origin iframe (Allow; and refused)
{
  await hp.goto(A + "/xframe");
  await gp2.goto(A + "/xframe");
  await sleep(1500);
  const xf = (p) => p.frames().find((f) => f.url().startsWith("http://localhost:8451/"));
  pop = await openPopup(H, hp);
  await pop.click("#anyStart");
  const asked = await until(() => pop.evaluate(() => !document.getElementById("vFrame").classList.contains("hidden") && { lead: document.getElementById("frameLead").textContent, btn: document.getElementById("frameAllow").textContent }), 8000);
  check("cross-origin player: popup asks to allow that site", !!asked && asked.btn === "Allow localhost:8451" && /player from localhost:8451/.test(asked.lead), JSON.stringify(asked));
  await pop.screenshot({ path: "any-popup-frame.png" });
  await pop.click("#frameAllow");
  const started = await until(() => pop.evaluate(() => !document.getElementById("vParty").classList.contains("hidden") && document.getElementById("copy").dataset.link), 12000);
  check("Allow → agent injected into the player frame, party started", !!started && !!keyOf(started));
  await pop.close();
  // guest: a refused permission first, then allowed
  pop = await openPopup(G, gp2);
  await pop.fill("#anyCodeIn", started);
  await pop.click("#anyCodeGo");
  await until(() => pop.evaluate(() => !document.getElementById("vFrame").classList.contains("hidden")), 8000);
  check("guest joined (before the player is allowed)", !!(await until(async () => (await people(gp2))?.length === 2, 10000)));
  const note = await until(async () => { const n = await anyNote(gp2); return /player from/.test(n) && n; }, 4000);
  check("guest panel: the video is in a player from localhost:8451", /player from localhost:8451/.test(note || ""), note);
  await pop.evaluate(() => (chrome.permissions.request = async () => false)); // the user says no
  await pop.click("#frameAllow");
  const denied = await until(() => pop.evaluate(() => document.getElementById("error").textContent), 4000);
  check("refused → clear message, nothing injected", /can't reach the video without access to localhost:8451/.test(denied || ""), denied);
  await pop.close();
  pop = await openPopup(G, gp2);
  // the popup notices the party and the player (permission already there in the test build) and brings the agent in
  await sleep(1500);
  await pop.close();
  const hf = xf(hp), gf = xf(gp2);
  check("guest's player frame driven after Allow", !!(await until(async () => (await anyNote(gp2)) === "", 6000)), await anyNote(gp2));
  await syncChecks("cross-origin iframe", hf, gf);
  // Theater on a cross-origin player: the iframe fills the window left of the chat
  await shadow(hp, (r) => { r.querySelector(".np-theater").click(); });
  await sleep(500);
  const fr = await hp.evaluate(() => { const r = document.querySelector("iframe").getBoundingClientRect(); const p = document.getElementById("netparty-root").shadowRoot.querySelector(".np-panel").getBoundingClientRect(); return { f: [r.left, r.top, r.width, r.height].map(Math.round), pl: Math.round(p.left), vh: innerHeight }; });
  const inner = await hf.evaluate(() => { const r = window.__v().getBoundingClientRect(); return [r.width, r.height].map(Math.round).concat([innerWidth, innerHeight]); });
  check("Theater with a cross-origin player: frame and video fill the space left of the chat", fr.f[0] === 0 && fr.f[1] === 0 && Math.abs(fr.f[2] - fr.pl) <= 1 && fr.f[3] === fr.vh && inner[0] === inner[2] && inner[1] === inner[3], JSON.stringify([fr, inner]));
  await shadow(hp, (r) => { r.querySelector(".np-theater").click(); });
  await endParty(H, hp);
}

// ================================================================ 6. two videos: the picker
{
  await hp.goto(A + "/two");
  await gp2.goto(A + "/two");
  await sleep(1500);
  await inject(H, hp);
  const c = await cmd(H, hp, { cmd: "create" });
  check("two similar videos: create shows the picker", c.picking === true, JSON.stringify(c));
  const boxes = await until(() => hp.evaluate(() => document.getElementById("netparty-picker")?.shadowRoot.querySelectorAll(".box").length), 3000);
  check("picker highlights both videos", boxes === 2, String(boxes));
  await hp.screenshot({ path: "any-picker.png" });
  await hp.evaluate(() => document.getElementById("netparty-picker").shadowRoot.querySelectorAll(".box")[1].click());
  const st = await until(async () => { const s = await cmd(H, hp, { cmd: "status" }); return s.roomId && s; }, 8000);
  check("picked video 2 → party started", !!st?.invite);
  await inject(G, gp2);
  const j = await cmd(G, gp2, { cmd: "join", roomId: st.roomId, key: keyOf(st.invite) });
  check("guest join → picker on the guest's page too", j.picking === true, JSON.stringify(j));
  await until(() => gp2.evaluate(() => !!document.getElementById("netparty-picker")), 3000);
  await gp2.evaluate(() => document.getElementById("netparty-picker").shadowRoot.querySelectorAll(".box")[1].click());
  await until(async () => (await people(gp2))?.length === 2, 8000);
  await syncChecks("picked video", hp, gp2);
  const other = await gp2.evaluate(() => document.getElementById("a").currentTime);
  check("the other video was left alone", other < 40, String(other));
  await endParty(H, hp);
}

// ================================================================ 7. duration mismatch → Open host's page
{
  await hp.goto(A + "/plain");
  await gp2.goto(A + "/short");
  await sleep(1500);
  await inject(H, hp);
  const c = await cmd(H, hp, { cmd: "create" });
  await inject(G, gp2);
  const room = c.invite.match(/\/j\/([a-z0-9]+)/)[1];
  await cmd(G, gp2, { cmd: "join", roomId: room, key: keyOf(c.invite) });
  const note = await until(async () => { const n = await anyNote(gp2); return /different video/.test(n) && n; }, 8000);
  check("different video (120 s vs 60 s) → 'You're on a different video'", !!note, String(note || (await anyNote(gp2))));
  const has = await shadow(gp2, (r) => { return !!r.querySelector(".np-any-open"); });
  check("…with an Open host's page button", has);
  await gp2.screenshot({ path: "any-mismatch.png" });
  await hp.evaluate(() => window.__v().pause());
  await sleep(1500);
  check("sync paused for the mismatched guest (still playing)", !(await vpaused(gp2)));
  await shadow(gp2, (r) => { r.querySelector(".np-any-open").click(); });
  await gp2.waitForURL(A + "/plain", { timeout: 8000 }).catch(() => {});
  check("Open host's page → the guest's tab goes to the host's page", gp2.url() === A + "/plain", gp2.url());
  await sleep(1200);
  pop = await openPopup(G, gp2);
  const jb = await pop.evaluate(() => ({ shown: !document.getElementById("anyJoinBox").classList.contains("hidden"), hint: document.getElementById("anyJoinHint").textContent }));
  check("popup there offers Join party on this tab (the tab's party)", jb.shown && jb.hint === "Party " + room, JSON.stringify(jb));
  await pop.click("#anyJoin");
  check("rejoined on the host's page", !!(await until(async () => (await people(gp2))?.length === 2, 10000)));
  await pop.close();
  check("no mismatch note any more", !!(await until(async () => (await anyNote(gp2)) === "", 5000)), await anyNote(gp2));
  await syncChecks("after Open host's page", hp, gp2, { seek: false });
  await endParty(H, hp);
}

// ================================================================ 8. live stream (infinite duration)
{
  await hp.goto(A + "/live");
  await gp2.goto(A + "/live");
  await sleep(1500);
  await inject(H, hp);
  const c = await cmd(H, hp, { cmd: "create" });
  check("live stream: party started", !!c.invite, JSON.stringify(c).replace(/#k=[\w-]+/, "#k=…"));
  await inject(G, gp2);
  const room = c.invite.match(/\/j\/([a-z0-9]+)/)[1];
  await cmd(G, gp2, { cmd: "join", roomId: room, key: keyOf(c.invite) });
  await until(async () => (await people(gp2))?.length === 2, 8000);
  const dur = await gp2.evaluate(() => window.__v().duration);
  check("live video has an infinite duration", dur === Infinity, String(dur));
  const note = await until(async () => { const n = await anyNote(gp2); return /Live stream/.test(n) && n; }, 5000);
  check("panel: live stream, only play and pause are synced", !!note, String(note));
  await syncChecks("live", hp, gp2, { seek: false });
  await endParty(H, hp);
}

// ================================================================ 9. canvas-only page
{
  await hp.goto(A + "/canvas");
  await sleep(800);
  await inject(H, hp);
  const c = await cmd(H, hp, { cmd: "create" });
  check("canvas-only player → No video found on this page", c.error === "No video found on this page.", JSON.stringify(c));
  pop = await openPopup(H, hp);
  await pop.click("#anyStart");
  const e = await until(() => pop.evaluate(() => document.getElementById("error").textContent), 4000);
  check("popup says No video found on this page", /^No video found on this page/.test(e || ""), e);
  await pop.close();
}

// ================================================================ 10. invite page refuses unsafe addresses
{
  const http = SERVER.replace(/^ws/, "http");
  const b64u = (b) => Buffer.from(b).toString("base64url");
  const enc = new TextEncoder();
  async function seal(keyStr, room, kind, obj) {
    const json = enc.encode(JSON.stringify(obj));
    const pt = new Uint8Array(Math.max(64, Math.ceil(json.length / 64) * 64)).fill(0x20);
    pt.set(json);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey("raw", Buffer.from(keyStr, "base64url"), { name: "AES-GCM" }, false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`netparty/e2ee/v1|${room}|${kind}|`) }, k, pt));
    return b64u(Buffer.concat([Buffer.from([1]), iv, ct]));
  }
  const bad = ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "https://user:pw@evil.example/x", "file:///etc/passwd", "https://evil.example/\"><script>alert(1)</script>", " https://evil.example/", "vbscript:x"];
  let refused = 0;
  for (const u of bad) {
    const key = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const ws = new WebSocket(SERVER);
    const msgs = [];
    await new Promise((r) => ws.once("open", r));
    ws.on("message", (d) => msgs.push(JSON.parse(d)));
    const req = (type, data, id) => (ws.send(JSON.stringify({ type, reqId: id, data })), until(() => msgs.find((m) => m.reqId === id), 3000));
    const snap = (await req("create", { e2ee: 1, cid: "ab".repeat(16), kc: await seal(key, "", "check", { check: "netparty" }), videoId: "av:AAAAAAAAAAAAAAAA", playing: false, position: 0 }, 1)).data;
    await req("page", { ct: await seal(key, snap.roomId, "page", { u, d: 100 }) }, 2);
    await gp2.goto(`${http}/j/${snap.roomId}#k=${key}`);
    const r = await until(() => gp2.evaluate(() => { const w = document.getElementById("warn"); return !w.hidden && { warn: w.textContent, go: !!document.getElementById("go"), scripts: document.scripts.length }; }), 3000);
    if (r && !r.go && /Can't open the host's page/.test(r.warn)) refused++;
    else out("not refused:", u, JSON.stringify(r));
    ws.close();
  }
  check(`invite page refuses ${bad.length} unsafe page addresses (javascript:, data:, file:, credentials, markup)`, refused === bad.length, `${refused}/${bad.length}`);
}

check("no script errors on the pages", errors.length === 0, errors.join(" | "));
const f = summary("ANY-VIDEO");
T.close();
stopPages();
await H.ctx.close();
await G.ctx.close();
process.exit(f ? 1 : 0);
