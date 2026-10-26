import { chromium } from "playwright";
import fs from "node:fs";
const EXT = new URL("../extension", import.meta.url).pathname;
const SERVER = process.env.SERVER || "ws://localhost:8787";
const SITE = process.env.SITE || "https://www.netflix.com/watch/12345";
const out = (...a) => console.log(...a);
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
  await new Promise((r) => setTimeout(r, 1000)); // let onInstalled finish first
  return { ctx, sw };
}
const shadow = (page, fn, arg) => page.evaluate(([f, a]) => {
  const r = document.getElementById("netparty-root")?.shadowRoot;
  return r ? new Function("r", "a", f)(r, a) : null;
}, [fn.toString().replace(/^[^{]*{|}$/g, ""), arg]);

const H = await launch("/tmp/pw-host"), G = await launch("/tmp/pw-guest");
for (const [x, name] of [[H, "Chirag"], [G, "Rahul"]])
  await x.sw.evaluate(([s, n]) => chrome.storage.sync.set({ serverUrl: s, name: n }), [SERVER, name]);

const hp = await H.ctx.newPage();
hp.on("console", (m) => m.text().includes("NetParty") && out("host console:", m.text()));
await hp.goto(SITE);
await hp.waitForTimeout(2500);
const created = await H.sw.evaluate(async (url) => {
  const [t] = await chrome.tabs.query({ url: url.split("?")[0] + "*" });
  return chrome.tabs.sendMessage(t.id, { cmd: "create" });
}, SITE);
out("create ->", JSON.stringify(created));
if (!created?.invite) process.exit(1);

// guest follows the invite link exactly like a friend would
const gp = await G.ctx.newPage();
gp.on("console", (m) => out("guest console:", m.text()));
await gp.goto(created.invite);
await gp.screenshot({ path: "invite.png" });
out("invite page:", (await gp.textContent("h1")).trim());
await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
out("guest landed on", gp.url());
for (let i = 0; i < 30; i++) {
  const n = await shadow(gp, (r) => { return r.querySelectorAll(".np-person").length; });
  if (n >= 2) { out("guest joined after", i * 0.5, "s"); break; }
  await gp.waitForTimeout(500);
}
out("host members:", JSON.stringify(await shadow(hp, (r) => { return [...r.querySelectorAll(".np-pname")].map((n) => n.textContent); })));
out("guest sys:", JSON.stringify(await shadow(gp, (r) => { return [...r.querySelectorAll(".np-sys")].map((n) => n.textContent); })));
const layout = async (p) => p.evaluate(() => {
  const r = (q) => document.querySelector(q).getBoundingClientRect();
  const panel = document.getElementById("netparty-root").shadowRoot.querySelector(".np-panel").getBoundingClientRect();
  return { vw: innerWidth, videoRight: Math.round(r("video").right), fsRight: Math.round(r("#fsbtn").right), panelLeft: Math.round(panel.left), panelW: Math.round(panel.width), docked: document.documentElement.classList.contains("np-docked") };
});
out("guest layout (docked):", JSON.stringify(await layout(gp)));
out("guest url after router strip:", gp.url());
const gMembers = await shadow(gp, (r) => { return [...r.querySelectorAll(".np-pname")].map((n) => n.textContent); });
out("guest sees members:", JSON.stringify(gMembers));

// chat: type + Enter on guest, check host gets it; page hotkeys must not eat Enter
await gp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-input").focus());
await gp.keyboard.type("hello from rahul");
await gp.keyboard.press("Enter");
await hp.waitForTimeout(1500);
const hostMsgs = await shadow(hp, (r) => { return [...r.querySelectorAll(".np-bubble")].map((n) => n.firstChild.textContent); });
out("host received:", JSON.stringify(hostMsgs));
out("page hotkeys triggered on guest:", await gp.evaluate(() => window.__hotkeys));
// space typed into chat must not pause the video
const gPausedBefore = await gp.evaluate(() => document.querySelector("video").paused);
// send button path
await hp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-input").focus());
await hp.keyboard.type("hey rahul, button test");
await hp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-send").click());
await gp.waitForTimeout(1500);
const guestMsgs = await shadow(gp, (r) => { return [...r.querySelectorAll(".np-bubble")].map((n) => n.firstChild.textContent); });
out("guest received:", JSON.stringify(guestMsgs));

// playback sync
await hp.evaluate(() => document.querySelector("video").pause());
await gp.waitForTimeout(2000);
out("guest paused after host pause:", await gp.evaluate(() => document.querySelector("video").paused));
await hp.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 60; v.play(); });
await gp.waitForTimeout(2500);
const [ht, gt] = [await hp.evaluate(() => document.querySelector("video").currentTime), await gp.evaluate(() => document.querySelector("video").currentTime)];
out("after host seek to 60s and play: host", ht.toFixed(1), "guest", gt.toFixed(1), "playing:", !(await gp.evaluate(() => document.querySelector("video").paused)));

await hp.screenshot({ path: "host-panel.png" });
await shadow(gp, (r) => { r.querySelector(".np-close").click(); });
await gp.waitForTimeout(300);
out("guest layout (chat hidden):", JSON.stringify(await gp.evaluate(() => ({ vw: innerWidth, videoRight: Math.round(document.querySelector("video").getBoundingClientRect().right), docked: document.documentElement.classList.contains("np-docked") }))));
await hp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-input").focus());
await hp.keyboard.type("toast test");
await hp.keyboard.press("Enter");
await gp.waitForTimeout(800);
await gp.screenshot({ path: "guest-closed.png" });

// popup render (in party) for the host
const extId = H.sw.url().split("/")[2];
const pop = await H.ctx.newPage();
await pop.setViewportSize({ width: 320, height: 520 });
await hp.bringToFront();
await pop.goto(`chrome-extension://${extId}/popup.html`);
await pop.waitForTimeout(800);
await pop.screenshot({ path: "popup.png" });
await H.ctx.close(); await G.ctx.close();
