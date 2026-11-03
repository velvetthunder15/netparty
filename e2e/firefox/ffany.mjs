// "Sync any video" (2.0) in real Firefox ESR: two Firefox profiles with the Firefox build, the local
// any-video test pages (../anysite.mjs: http://localhost:8450, second origin :8451) and the local server
// behind the TLS recording proxy.
//
// Like ../anyvideo.mjs, activeTab can't be granted by automation (it needs a real toolbar click), so the
// build used here is a TEST COPY whose manifest also lists http://localhost:8450/* and :8451/* in
// host_permissions (as http://localhost/*). The popup (popup.html opened in a tab) then runs its real code: scripting.executeScript
// after the click, permissions.request (already granted, so no prompt), registerContentScripts.
//
// Covers: popup Sync this tab, invite page in Firefox (decrypts the page address), Open the video →
// guest popup Join party on this tab, play/pause/seek sync both ways within 1 s, speed, drift nudge,
// element swap, Theater, cross-origin iframe (Allow), picker, mismatch, live stream, Always allow + reload,
// leak audit.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import fs from "node:fs";
const SRC_BUILD = process.env.BUILD || "/workspace/work/ff/build";
const TEST_BUILD = "/tmp/ff-any-build";
fs.rmSync(TEST_BUILD, { recursive: true, force: true });
fs.cpSync(SRC_BUILD, TEST_BUILD, { recursive: true });
const man = JSON.parse(fs.readFileSync(TEST_BUILD + "/manifest.json", "utf8"));
man.host_permissions.push("http://localhost/*"); // both test origins (:8450, :8451); match patterns cover every port
fs.writeFileSync(TEST_BUILD + "/manifest.json", JSON.stringify(man, null, 2));
process.env.BUILD = TEST_BUILD;
const { launchFF, extPage, tapTLS } = await import("./fflib.mjs");
const { shadow, until, people, check, summary, out, sleep, leaks, keyOf } = await import("/workspace/work/e2e/lib.mjs");
const { start: startPages } = await import("/workspace/work/e2e/anysite.mjs");

const A = "http://localhost:8450";
const stopPages = startPages();
const T = tapTLS(8792, 8787);
const UH = "aaaaaaaa-0000-4000-8000-000000000011", UG = "aaaaaaaa-0000-4000-8000-000000000012";
const H = await launchFF("/tmp/ff-any-host", { uuid: UH });
const G = await launchFF("/tmp/ff-any-guest", { uuid: UG });
out("Firefox", await H.browser.version());
for (const [x, name] of [[H, "Chirag"], [G, "Rahul"]]) {
  const e = await extPage(x);
  await e.evaluate((u, n) => chrome.storage.sync.set({ serverUrl: u, name: n }), T.url, name);
  check(`${name}: version ${await e.evaluate(() => chrome.runtime.getManifest().version)}, activeTab + scripting granted`, await e.evaluate(async () => { const p = await chrome.permissions.getAll(); return p.permissions.includes("activeTab") && p.permissions.includes("scripting"); }));
  await e.close();
}
const errors = [];
const watch = (p, n) => {
  p.on("pageerror", (e) => (/favicon\.ico/.test(String(e.message || e)) ? 0 : (errors.push(n + ": " + String(e.message || e)), out(n + " pageerror:", String(e.message || e)))));
  if (process.env.DEBUG) p.on("console", (m) => out(n + " console:", m.text().slice(0, 200)));
};
const go = (p, u) => p.goto(u, { waitUntil: "domcontentloaded", timeout: 20000 });
async function openPopup(x, page) {
  const pop = await x.browser.newPage();
  await pop.setViewport({ width: 320, height: 640 });
  await page.bringToFront();
  await pop.goto(`${x.base}/popup.html`, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
  await sleep(1000);
  return pop;
}
const visible = (pop, id) => pop.evaluate((i) => !document.getElementById(i).classList.contains("hidden"), id);
const FILES = ["any-mode.js", "early.js", "emoji-data.js", "anyvideo.js", "content.js"];
// the popup's own steps (inject after the click, then a command), run from an extension page
async function api(x, page, msg, { inject = false } = {}) {
  const e = await extPage(x);
  const r = await e.evaluate(
    async (u, m, files, inj) => {
      const t = (await chrome.tabs.query({})).find((t) => t.url === u);
      if (!t) return { error: "no tab" };
      if (inj) {
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files });
        for (let i = 0; i < 40; i++) {
          const s = await chrome.tabs.sendMessage(t.id, { cmd: "status" }, { frameId: 0 }).catch(() => null);
          if (s?.booted) break;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      return m ? chrome.tabs.sendMessage(t.id, m, { frameId: 0 }).catch((err) => ({ error: String(err) })) : { ok: true };
    },
    page.url(),
    msg,
    FILES,
    inject,
  );
  await e.close();
  return r;
}
const vt = (c) => c.evaluate(() => window.__v().currentTime);
const vpaused = (c) => c.evaluate(() => window.__v().paused);
const vrate = (c) => c.evaluate(() => window.__v().playbackRate);
const gap = async (a, b) => Math.abs((await vt(a)) - (await vt(b)));
const anyNote = (p) => shadow(p, (r) => { const n = r.querySelector(".np-any-note"); return n && !n.hidden ? n.textContent : ""; });
const playAll = (c) => c.evaluate(() => window.__v().play().then(() => true, (e) => String(e)));
async function syncChecks(label, hc, gc, { seek = true } = {}) {
  await playAll(hc);
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
  await playAll(hc);
  check(`${label}: host play → guest plays`, !!(await until(async () => !(await vpaused(gc)), 4000)));
  if (seek) {
    await sleep(2500);
    const g1 = await gap(hc, gc);
    check(`${label}: playing in sync (gap < 1 s)`, g1 < 1, `gap ${g1.toFixed(2)} s`);
    await gc.evaluate(() => (window.__v().currentTime = 55));
    const ok = await until(async () => Math.abs((await vt(hc)) - (await vt(gc))) < 1 && (await vt(hc)) > 54, 5000, 100);
    check(`${label}: guest seek to 55 s → host follows within 1 s`, !!ok, `host ${(await vt(hc)).toFixed(2)} guest ${(await vt(gc)).toFixed(2)}`);
  }
}

const hp = await H.browser.newPage();
const gp = await G.browser.newPage();
watch(hp, "host");
watch(gp, "guest");

// ---- 1. popup Sync this tab → invite → Open the video → Join party on this tab
await go(hp, A + "/plain");
await sleep(1500);
let pop = await openPopup(H, hp);
check("Firefox popup on another site: Sync this tab", (await visible(pop, "vAny")) && (await pop.evaluate(() => document.getElementById("anyStart").textContent)) === "Sync this tab");
await pop.click("#anyStart");
const INVITE = await until(() => pop.evaluate(() => !document.getElementById("vParty").classList.contains("hidden") && document.getElementById("copy").dataset.link), 12000);
check("Sync this tab → party (scripts injected after the click)", !!keyOf(INVITE || ""), String(INVITE).replace(/#k=.*/, "#k=…") + " " + (await pop.evaluate(() => document.getElementById("error").textContent + " | " + document.getElementById("anyMsg").textContent)));
if (!INVITE) out("granted:", JSON.stringify(await pop.evaluate(() => chrome.permissions.getAll())));
await pop.close();
if (!INVITE) process.exit(1);
await go(gp, INVITE);
const btn = await until(() => gp.evaluate(() => { const b = document.getElementById("go"); return b && !b.hidden && { href: b.href, text: b.textContent }; }), 8000);
check("Firefox invite page decrypts the page address: Open the video → host's page", btn?.href === A + "/plain" && btn.text === "Open the video", JSON.stringify(btn));
const newTab = new Promise((r) => G.browser.once("targetcreated", async (t) => r(await t.page())));
await gp.click("#go");
const gp2 = await Promise.race([newTab, sleep(10000).then(() => null)]);
check("Open the video opened a new tab", !!gp2);
watch(gp2, "guest");
await until(async () => gp2.url() === A + "/plain", 8000);
await sleep(1500);
pop = await openPopup(G, gp2);
const jb = await pop.evaluate(() => ({ shown: !document.getElementById("anyJoinBox").classList.contains("hidden"), hint: document.getElementById("anyJoinHint").textContent }));
check("guest popup: Join party on this tab", jb.shown && /from the invite you opened/.test(jb.hint), JSON.stringify(jb));
await pop.click("#anyJoin");
check("guest joined", !!(await until(async () => (await people(gp2))?.length === 2, 15000)), JSON.stringify(await people(gp2)));
await pop.close();
await syncChecks("Firefox plain", hp, gp2);
await sleep(2200);
await hp.evaluate(() => (window.__v().playbackRate = 1.5));
check("speed 1.5x follows", !!(await until(async () => Math.abs((await vrate(gp2)) - 1.5) < 0.2, 4000)), String(await vrate(gp2)));
await hp.evaluate(() => (window.__v().playbackRate = 1));
await until(async () => Math.abs((await vrate(gp2)) - 1) < 0.15, 4000);
await sleep(4000);
await gp2.evaluate(() => { window.__stop = (e) => e.stopPropagation(); for (const t of ["seeked", "seeking"]) window.addEventListener(t, window.__stop, true); window.__v().currentTime -= 0.9; });
const nudged = await until(async () => (await vrate(gp2)) > 1.01 && (await vrate(gp2)), 5000, 100);
check("drift 0.9 s → speed nudge", !!nudged, String(nudged));
check("…gap closed, back to 1x", !!(await until(async () => (await gap(hp, gp2)) < 0.3 && (await vrate(gp2)) === 1, 20000, 250)), `gap ${(await gap(hp, gp2)).toFixed(2)}`);
await gp2.evaluate(() => { for (const t of ["seeked", "seeking"]) window.removeEventListener(t, window.__stop, true); });
await sleep(2500);
await hp.evaluate(() => window.__swap());
await sleep(2500);
await hp.evaluate(() => window.__v().pause());
check("host <video> swapped mid-play → still synced", !!(await until(() => vpaused(gp2), 4000)));
// Theater
await shadow(hp, (r) => { r.querySelector(".np-theater").click(); });
await sleep(500);
const th = await hp.evaluate(() => { const v = window.__v().getBoundingClientRect(); const p = document.getElementById("netparty-root").shadowRoot.querySelector(".np-panel").getBoundingClientRect(); return { v: [v.left, v.top, v.width, v.height].map(Math.round), pl: Math.round(p.left), vh: innerHeight }; });
check("Theater in Firefox: video fills the window left of the chat", th.v[0] === 0 && th.v[1] === 0 && Math.abs(th.v[2] - th.pl) <= 1 && th.v[3] === th.vh, JSON.stringify(th));
await shadow(hp, (r) => { r.querySelector(".np-theater").click(); });
// Always allow + reload
pop = await openPopup(H, hp);
await pop.click("#anyAlways");
const msg = await until(() => pop.evaluate(() => document.getElementById("anyMsg").textContent), 5000);
check("Always allow in Firefox", /starts on this site by itself/.test(msg || ""), msg);
const regs = await pop.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
check("registered content scripts for the site", regs.length === 2, JSON.stringify(regs));
await pop.close();
await hp.reload({ waitUntil: "domcontentloaded" });
check("reload on the allowed site → back in the party as host", !!(await until(async () => JSON.stringify(await people(hp)) === '["You","Rahul"]', 15000)), JSON.stringify(await people(hp)));
pop = await openPopup(H, hp);
await pop.click("#anyAlways");
await sleep(600);
check("unticked → unregistered", (await pop.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)) === 0);
await pop.close();
const secret = ["Chirag", "Rahul", "/plain", "localhost:8450", keyOf(INVITE)];
check("no WebSocket frame contains names, the page address or the key", leaks(T.frames, secret).length === 0, JSON.stringify(leaks(T.frames, secret)));
await api(H, hp, { cmd: "leave" });
await gp.close();

// ---- 2. cross-origin iframe player (Allow in the popup)
await go(hp, A + "/xframe");
await go(gp2, A + "/xframe");
await sleep(1500);
pop = await openPopup(H, hp);
await pop.click("#anyStart");
check("cross-origin player: popup asks to allow localhost:8451", !!(await until(() => pop.evaluate(() => !document.getElementById("vFrame").classList.contains("hidden") && document.getElementById("frameAllow").textContent === "Allow localhost:8451"), 8000)));
await pop.click("#frameAllow");
const inv2 = await until(() => pop.evaluate(() => !document.getElementById("vParty").classList.contains("hidden") && document.getElementById("copy").dataset.link), 12000);
check("Allow → party on the cross-origin player", !!keyOf(inv2 || ""));
await pop.close();
pop = await openPopup(G, gp2);
await pop.type("#anyCodeIn", inv2);
await pop.click("#anyCodeGo");
await until(() => pop.evaluate(() => !document.getElementById("vFrame").classList.contains("hidden")), 8000);
await pop.click("#frameAllow");
check("guest joined, player allowed", !!(await until(async () => (await people(gp2))?.length === 2 && (await anyNote(gp2)) === "", 12000)), await anyNote(gp2));
await pop.close();
const xf = (p) => p.frames().find((f) => f.url().startsWith("http://localhost:8451/"));
await syncChecks("Firefox cross-origin iframe", xf(hp), xf(gp2));
await api(H, hp, { cmd: "leave" });

// ---- 3. two videos (picker), 4. mismatch, 5. live
await go(hp, A + "/two");
await go(gp2, A + "/two");
await sleep(1500);
const c3 = await api(H, hp, { cmd: "create" }, { inject: true });
check("two videos → picker", c3.picking === true, JSON.stringify(c3));
await until(() => hp.evaluate(() => !!document.getElementById("netparty-picker")), 3000);
await hp.evaluate(() => document.getElementById("netparty-picker").shadowRoot.querySelectorAll(".box")[1].click());
const st3 = await until(async () => { const s = await api(H, hp, { cmd: "status" }); return s.roomId && s; }, 8000);
const j3 = await api(G, gp2, { cmd: "join", roomId: st3.roomId, key: keyOf(st3.invite) }, { inject: true });
await until(() => gp2.evaluate(() => !!document.getElementById("netparty-picker")), 3000);
await gp2.evaluate(() => document.getElementById("netparty-picker").shadowRoot.querySelectorAll(".box")[1].click());
check("guest picks too", j3.picking === true && !!(await until(async () => (await people(gp2))?.length === 2, 8000)));
await syncChecks("Firefox picker", hp, gp2, { seek: false });
await api(H, hp, { cmd: "leave" });

await go(hp, A + "/plain");
await go(gp2, A + "/short");
await sleep(1500);
const c4 = await api(H, hp, { cmd: "create" }, { inject: true });
await api(G, gp2, { cmd: "join", roomId: c4.invite.match(/\/j\/([a-z0-9]+)/)[1], key: keyOf(c4.invite) }, { inject: true });
check("Firefox: different video → note with Open host's page", !!(await until(async () => /different video/.test(await anyNote(gp2)), 8000)) && (await shadow(gp2, (r) => { return !!r.querySelector(".np-any-open"); })));
await api(H, hp, { cmd: "leave" });

await go(hp, A + "/live");
await go(gp2, A + "/live");
await sleep(1500);
const c5 = await api(H, hp, { cmd: "create" }, { inject: true });
await api(G, gp2, { cmd: "join", roomId: c5.invite.match(/\/j\/([a-z0-9]+)/)[1], key: keyOf(c5.invite) }, { inject: true });
await until(async () => (await people(gp2))?.length === 2, 8000);
check("Firefox live stream: note shown", !!(await until(async () => /Live stream/.test(await anyNote(gp2)), 6000)), await anyNote(gp2));
await syncChecks("Firefox live", hp, gp2, { seek: false });
await api(H, hp, { cmd: "leave" });

check("no script errors on the pages", errors.length === 0, errors.join(" | "));
const f = summary("FIREFOX ANY-VIDEO");
await H.browser.close();
await G.browser.close();
T.close();
stopPages();
process.exit(f ? 1 : 0);
