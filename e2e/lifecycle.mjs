// Party lifecycle e2e: "Start a NetParty" button, next episode keeps the party,
// leaving the title ends it (host) / leaves it (guest), nobody gets pulled back in.
import { chromium } from "/workspace/work/pw/node_modules/playwright/index.mjs";
import fs from "node:fs";
const EXT = "/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/extension";
const SERVER = process.env.SERVER || "ws://localhost:8787";
const HOT = process.env.HOT === "1";
const out = (...a) => console.log(...a);
let fails = 0;
const check = (name, cond, extra = "") => {
  out((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
  if (!cond) fails++;
};
async function launch(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: "/usr/bin/chromium",
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: [
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--host-resolver-rules=MAP www.netflix.com:443 127.0.0.1:8443, MAP www.hotstar.com:443 127.0.0.1:8443",
      "--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--no-proxy-server",
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  await new Promise((r) => setTimeout(r, 1000));
  return { ctx, sw };
}
const status = (x, page) =>
  x.sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => t.url === u) || tabs.find((t) => /netflix|hotstar/.test(t.url || ""));
    return chrome.tabs.sendMessage(t.id, { cmd: "status" }).catch((e) => ({ error: String(e) }));
  }, page.url());
const people = (p) => p.evaluate(() => [...(document.getElementById("netparty-root")?.shadowRoot?.querySelectorAll(".np-pname") || [])].map((n) => n.textContent));
const noticeText = (p) => p.evaluate(() => document.getElementById("netparty-notice")?.shadowRoot?.querySelector(".n")?.textContent || "");
async function until(fn, ms = 10000) {
  for (let t = 0; t < ms; t += 250) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const H = await launch("/tmp/pw-lh"), G = await launch("/tmp/pw-lg");
for (const [x, name] of [[H, "Chirag"], [G, "Rahul"]])
  await x.sw.evaluate(([s, n]) => chrome.storage.sync.set({ serverUrl: s, name: n }), [SERVER, name]);
const hp = await H.ctx.newPage();
const gp = await G.ctx.newPage();
for (const [p, n] of [[hp, "host"], [gp, "guest"]]) {
  p.on("pageerror", (e) => out(n + " pageerror:", e.message));
  if (process.env.DEBUG) p.on("console", (m) => out(n + " console:", m.text().slice(0, 200)));
}

// 1. Start a NetParty button on the title page
await hp.goto(HOT ? "https://www.hotstar.com/in/movies/fake-movie/1260000001" : "https://www.netflix.com/browse");
const btn = await until(() => hp.$("[data-netparty-start]"), 6000);
check("start button shown on title page", !!btn);
if (btn) {
  const geo = await hp.evaluate((hot) => {
    const b = document.querySelector("[data-netparty-start]").getBoundingClientRect();
    const ref = document.querySelector(hot ? "#hswatch" : "#nfplay").getBoundingClientRect();
    return { b: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], ref: [Math.round(ref.left), Math.round(ref.top), Math.round(ref.width), Math.round(ref.height)] };
  }, HOT);
  check("button placed next to " + (HOT ? "Watch" : "Play"), HOT ? (geo.b[1] >= geo.ref[1] + geo.ref[3] || geo.b[0] >= geo.ref[0] + geo.ref[2]) : geo.b[0] >= geo.ref[0] + geo.ref[2] && Math.abs(geo.b[3] - geo.ref[3]) <= 2, JSON.stringify(geo));
  await hp.screenshot({ path: (HOT ? "hs" : "nf") + "-start-button.png" });
  await btn.click();
}
const hst = await until(async () => { const s = await status(H, hp); return s?.roomId ? s : null; }, 25000);
check("click creates the party on the watch page", !!hst?.roomId && hst.onWatchPage, hp.url());
const room = hst?.roomId;
if (!room) { out("exit early"); process.exit(1); }
check("chat panel open after start", await hp.evaluate(() => document.documentElement.classList.contains("np-docked")));

// 2. guest joins with the invite link
await gp.goto(hst.invite);
await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
check("guest joins", !!(await until(async () => (await people(gp)).length === 2, 25000)));

// 3. next episode: party continues, guest follows
const nextPath = HOT ? "/in/shows/fake-show/1260000002/ep-2/1260000099/watch" : "/watch/67890";
await hp.evaluate((p) => window.__go(p), nextPath);
const followed = await until(async () => gp.url().includes(HOT ? "1260000099" : "67890") && (await people(gp)).length === 2, 20000);
check("next episode keeps party and guest follows", !!followed, gp.url());
// chat still decrypts on both sides after the episode change (the key survived the navigation)
const bub = (p) => p.evaluate(() => [...(document.getElementById("netparty-root")?.shadowRoot?.querySelectorAll(".np-bubble") || [])].map((n) => n.firstChild.textContent));
await hp.evaluate(() => { const r = document.getElementById("netparty-root").shadowRoot; r.querySelector(".np-input").value = "episode two!"; r.querySelector(".np-send").disabled = false; r.querySelector(".np-send").click(); });
check("chat after the episode change reaches the guest (still decrypting)", !!(await until(async () => (await bub(gp)).includes("episode two!"), 8000)), JSON.stringify(await bub(gp)));
check("no key left in either address bar", !/npKey/.test(gp.url() + hp.url()));
const hs2 = await status(H, hp);
check("host still in same party after episode change", hs2.roomId === room && hs2.isHost);

if (process.env.STOP3) process.exit(0);
// 4. guest exits the title: guest leaves, is not pulled back in, host keeps the party
await gp.evaluate((p) => window.__go(p), HOT ? "/in/home" : "/browse");
await gp.waitForTimeout(5000);
const gs = await status(G, gp);
check("guest who exits is out of the party", !gs.roomId, JSON.stringify({ roomId: gs.roomId, notice: await noticeText(gp) }));
await gp.waitForTimeout(4000);
check("guest is NOT pulled back into the title", !/watch/.test(gp.url()), gp.url());
check("host now sees 1 member", !!(await until(async () => (await people(hp)).length === 1, 20000)));
const hs3 = await status(H, hp);
check("host party still running", hs3.roomId === room);

// 5. guest rejoins, then host exits: party disbands for everyone
await gp.goto(hst.invite);
await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
check("guest rejoins", !!(await until(async () => (await people(gp)).length === 2, 25000)));
const guestUrl = gp.url();
await hp.evaluate((p) => window.__go(p), HOT ? "/in/home" : "/browse");
await hp.waitForTimeout(5000);
const hs4 = await status(H, hp);
check("host who exits ends the party", !hs4.roomId, await noticeText(hp));
check("host is NOT pulled back into the title", !/watch/.test(hp.url()), hp.url());
const gs4 = await until(async () => { const s = await status(G, gp); return !s.roomId ? s : null; }, 8000);
check("guest told the party ended", !!gs4 && /ended/.test(await noticeText(gp)), await noticeText(gp));
check("guest panel closed and video full width", await gp.evaluate(() => !document.documentElement.classList.contains("np-docked") && Math.round(document.querySelector("video").getBoundingClientRect().width) === innerWidth));
check("guest stays on the page they were on", gp.url() === guestUrl, gp.url());
const page = await fetch(SERVER.replace(/^ws/, "http") + "/j/" + room);
check("invite link now says ended", page.status === 404);
await gp.screenshot({ path: (HOT ? "hs" : "nf") + "-ended.png" });

// 6. joining an ended party: clear message, no stuck "reconnecting"
await gp.goto(hst.invite.replace(/\/j\/.*/, "/j/" + room));
// the full (stale) link, key included: the party is gone, so "ended", not a key problem
const KEY = (hst.invite.match(/#k=([\w-]{43})$/) || [])[1];
await hp.goto((HOT ? "https://www.hotstar.com/in/movies/fake-movie/1260000001/watch?npParty=" + room : "https://www.netflix.com/watch/12345?npParty=" + room) + "#npKey=" + KEY);
const n6 = await until(async () => /ended/.test(await noticeText(hp)) && (await noticeText(hp)), 25000);
check("stale invite shows 'party ended' notice", !!n6, n6 || "");

out(fails ? `\n${fails} FAILED` : "\nALL LIFECYCLE CHECKS PASSED");
await H.ctx.close();
await G.ctx.close();
process.exit(fails ? 1 : 0);
