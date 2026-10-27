// Store screenshots: real NetParty UI on the fake Netflix player, dressed with our own stills.
import fs from "node:fs";
import { launch, shadow, until, people, sleep } from "./lib.mjs";
const OUT = "/workspace/work/store/raw";
fs.mkdirSync(OUT, { recursive: true });
const SITE = "https://www.netflix.com/watch/12345";
const still = (n) => "data:image/jpeg;base64," + fs.readFileSync(`/workspace/work/store/still-${n}.b64`, "utf8");
const dress = async (p, img, t = "1:12:48", pct = 54) => {
  await p.evaluate(([img, t, pct]) => {
    const pv = document.querySelector(".watch-video--player-view");
    document.getElementById("v").style.opacity = "0";
    document.querySelector('[data-uia="video-title"]').style.display = "none";
    document.querySelector(".controls").style.display = "none";
    pv.style.background = `#000 url(${img}) center/cover no-repeat`;
    document.getElementById("np-fake-ui")?.remove();
    const ui = document.createElement("div");
    ui.id = "np-fake-ui";
    ui.innerHTML = `<div style="position:absolute;left:0;right:0;bottom:0;padding:60px 28px 22px;background:linear-gradient(transparent,rgba(0,0,0,.75));font:500 14px/1 system-ui,sans-serif;color:#fff">
      <div style="display:flex;align-items:center;gap:14px"><span style="font-size:22px">❚❚</span>
      <div style="flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.3);position:relative"><div style="position:absolute;inset:0 ${100 - pct}% 0 0;background:#e5e5e5;border-radius:2px"></div><div style="position:absolute;left:calc(${pct}% - 7px);top:-5px;width:14px;height:14px;border-radius:50%;background:#fff"></div></div>
      </div></div>`;
    pv.append(ui);
  }, [img, t, pct]);
};
const say = async (p, text) => { await p.locator(".np-input").click(); await p.keyboard.type(text); await p.keyboard.press("Enter"); await sleep(250); };

const H = await launch("/tmp/pw-sh", { name: "Chirag", avatar: "🦊" });
const G = await launch("/tmp/pw-sg", { name: "Rahul", avatar: "🐼" });
const A = await launch("/tmp/pw-sa", { name: "Ananya", avatar: "🐰" });
const hp = await H.ctx.newPage(); await hp.setViewportSize({ width: 1280, height: 800 });
const gp = await G.ctx.newPage(); await gp.setViewportSize({ width: 1280, height: 800 });
const ap = await A.ctx.newPage(); await ap.setViewportSize({ width: 1280, height: 800 });
await hp.goto(SITE); await hp.waitForTimeout(2000);
const created = await H.sw.evaluate(async (url) => { const [t] = await chrome.tabs.query({ url: url + "*" }); return chrome.tabs.sendMessage(t.id, { cmd: "create" }); }, SITE);
console.log("invite", created.invite);
for (const p of [gp, ap]) { await p.goto(created.invite); await sleep(1500); await Promise.all([p.waitForNavigation(), p.click("a.btn")]); }
await until(async () => (await people(hp)).length === 3, 20000);
for (const p of [hp, gp, ap]) await dress(p, still("space"));
await say(gp, "okay this planet shot is unreal");
await say(ap, "the music in this part 😭");
await say(hp, "wait till you see what happens next 🍿");
await say(gp, "no spoilers!!");
await say(ap, "is he going down there alone??");
await say(hp, "just watch 👀");
await sleep(800);
// 1: chat beside the video, with a few reactions in the air
await hp.mouse.move(400, 300);
for (const [p, e] of [[gp, "😂"], [ap, "😱"], [gp, "😂"], [ap, "🥰"]]) {
  await p.locator('.np-tool[aria-label="Reactions"]').hover(); await sleep(200);
  await p.locator(`.np-react-btn[data-emoji="${e}"]`).click(); await sleep(260);
}
await p_close(gp); await p_close(ap);
await sleep(600);
await hp.screenshot({ path: `${OUT}/chat.png` });
// 2: reactions tray open on the host, tapping 😂 a few times
await hp.locator('.np-tool[aria-label="Reactions"]').hover(); await sleep(300);
for (let i = 0; i < 4; i++) { await hp.locator('.np-react-btn[data-emoji="😂"]').click(); await sleep(170); }
await sleep(500);
await hp.screenshot({ path: `${OUT}/reactions.png` });
await hp.mouse.move(400, 300); await sleep(4000);
// 3: neon scene, new chat
for (const p of [hp, gp, ap]) await dress(p, still("neon"), "", 31);
await say(ap, "okay this city is gorgeous");
await say(gp, "that umbrella 😍");
await say(hp, "best episode so far");
await say(ap, "next one after this?");
await say(gp, "obviously");
await sleep(800); await hp.mouse.move(400, 300);
await hp.screenshot({ path: `${OUT}/chat-neon.png` });
// 4: voice chat
for (const p of [hp, gp, ap]) { await p.locator(".np-voice button").first().click().catch(() => {}); await sleep(1200); }
await sleep(3000);
await hp.mouse.move(400, 300);
await hp.screenshot({ path: `${OUT}/voice.png` });
// 5: popup
const ext = new URL(H.sw.url()).host;
const pop = await H.ctx.newPage(); await pop.setViewportSize({ width: 380, height: 640 });
await pop.goto(`chrome-extension://${ext}/popup.html`); await sleep(1500);
await pop.screenshot({ path: `${OUT}/popup.png`, fullPage: true });
await hp.bringToFront();
console.log("done");
for (const x of [H, G, A]) await x.ctx.close();
async function p_close(p) { await p.mouse.move(300, 300); }
