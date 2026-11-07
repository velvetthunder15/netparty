// Firefox coverage for the 2.2 platforms. Every page is served by ../fakesite.mjs;
// this does not sign in to, or verify playback on, the real streaming services.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import { launchFF, extPage, tapTLS } from "./fflib.mjs";
import { until, check, summary, out, sleep, people, keyOf } from "../lib.mjs";

const T = tapTLS(8792, 8787);
const H = await launchFF("ff-platform-host", { uuid: "aaaaaaaa-0000-4000-8000-000000000021" });
const G = await launchFF("ff-platform-guest", { uuid: "aaaaaaaa-0000-4000-8000-000000000022" });
const he = await extPage(H), ge = await extPage(G);
await he.evaluate((url) => chrome.storage.sync.set({ serverUrl: url, name: "Chirag" }), T.url);
await ge.evaluate((url) => chrome.storage.sync.set({ serverUrl: url, name: "Rahul" }), T.url);
const errors = [];
const watch = (p, name) => p.on("pageerror", (e) => {
  if (!/favicon\.ico/.test(String(e.message || e))) errors.push(`${name}: ${e.message || e}`);
});
const status = (ext, p) => ext.evaluate(async (url) => {
  const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
  return tab ? chrome.tabs.sendMessage(tab.id, { cmd: "status" }).catch((e) => ({ error: String(e) })) : { error: "tab missing" };
}, p.url());
const create = (ext, p) => ext.evaluate(async (url) => {
  const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
  return tab ? chrome.tabs.sendMessage(tab.id, { cmd: "create" }).catch((e) => ({ error: String(e) })) : { error: "tab missing" };
}, p.url());
const frame = (p) => p.frames().find((f) => /^https:\/\/static\.crunchyroll\.com\/vilos-v2\//.test(f.url()));
const player = (p, service) => service.frame ? frame(p) : p;
const video = async (p, service) => player(p, service)?.evaluate((sel) => {
  const v = document.querySelector(sel);
  return v ? { t: v.currentTime, paused: v.paused } : null;
}, service.video).catch(() => null);
const act = async (p, service, action, time) => {
  const target = await until(() => player(p, service), 8000);
  if (!target) throw new Error(`${service.name} player frame missing`);
  return target.evaluate(({ sel, action, time }) => {
    const v = document.querySelector(sel);
    if (action === "pause") v.pause();
    if (action === "play") { v.currentTime = time; return v.play(); }
    if (action === "seek") v.currentTime = time;
  }, { sel: service.video, action, time });
};
const near = (a, b) => Math.abs(a - b) < 1.5;
const services = [
  {
    name: "HBO Max", home: "https://play.hbomax.com/",
    start: "https://play.max.com/video/watch/1f4b4570-933c-4264-b6e4-4aa9f596a9f5/a4f1e82b-a9f0-4e73-a692-35b31b9e0608",
    watch: /^https:\/\/play\.hbomax\.com\/video\/watch\/1f4b4570-933c-4264-b6e4-4aa9f596a9f5\/a4f1e82b-a9f0-4e73-a692-35b31b9e0608$/,
    invite: /^https:\/\/play\.hbomax\.com\/video\/watch\/[^?]+\?npParty=[a-z0-9]+#npKey=[\w-]{43}$/,
    video: "[data-testid=playerContainer] video",
  },
  {
    name: "Crunchyroll", home: "https://www.crunchyroll.com/",
    start: "https://www.crunchyroll.com/watch/GY0973WVY/the-talisman-woman",
    watch: /^https:\/\/www\.crunchyroll\.com\/watch\/GY0973WVY\/the-talisman-woman$/,
    invite: /^https:\/\/www\.crunchyroll\.com\/watch\/GY0973WVY\?npParty=[a-z0-9]+#npKey=[\w-]{43}$/,
    video: "video", frame: true,
  },
  {
    name: "SonyLIV", home: "https://www.sonyliv.com/",
    start: "https://www.sonyliv.com/shows/bachelors-delight-1700000113/achaari-cheese-toast-1000022678",
    watch: /^https:\/\/www\.sonyliv\.com\/shows\/bachelors-delight-1700000113\/achaari-cheese-toast-1000022678\?watch=true$/,
    invite: /^https:\/\/www\.sonyliv\.com\/shows\/bachelors-delight-1700000113\/achaari-cheese-toast-1000022678\?watch=true&npParty=[a-z0-9]+#npKey=[\w-]{43}$/,
    video: ".playerContainer video", detailFirst: true,
  },
];

for (const s of services) {
  out(`Firefox fixture: ${s.name}`);
  const hp = await H.browser.newPage(), gp = await G.browser.newPage();
  watch(hp, `${s.name} host`); watch(gp, `${s.name} guest`);
  await hp.goto(s.home, { waitUntil: "domcontentloaded" });
  const home = await until(async () => { const x = await status(he, hp); return x.site === s.name ? x : null; }, 8000);
  check(`${s.name}: Firefox recognizes the service, home is not a watch page`, !!home && home.onWatchPage === false, JSON.stringify(home));
  await hp.goto(s.start, { waitUntil: "domcontentloaded" });
  if (s.detailFirst) {
    const detail = await until(async () => { const x = await status(he, hp); return x.site === s.name ? x : null; }, 8000);
    check(`${s.name}: hero video is not a watch page`, !!detail && detail.onWatchPage === false, JSON.stringify(detail));
    await hp.click("#slwatch");
  }
  check(`${s.name}: fixture watch URL`, !!(await until(() => s.watch.test(hp.url()), 8000)), hp.url());
  const detected = await until(async () => { const x = await status(he, hp); return x.onWatchPage ? x : null; }, 8000);
  check(`${s.name}: Firefox detects the watch page`, detected?.site === s.name, JSON.stringify(detected));
  await hp.bringToFront();
  const pop = await H.browser.newPage();
  await pop.setViewport({ width: 320, height: 600 });
  await pop.goto(`${H.base}/popup.html`, { waitUntil: "domcontentloaded" });
  const popupReady = await until(() => pop.evaluate(() =>
    !document.getElementById("vIdle").classList.contains("hidden") &&
    !document.getElementById("create").disabled &&
    document.getElementById("startHint").textContent,
  ), 8000);
  check(`${s.name}: Firefox popup offers Start for this service`, !!popupReady && popupReady.includes(s.name), String(popupReady));
  await pop.close();
  if (s.frame) {
    check("Crunchyroll: player is a cross-origin iframe", !!(await until(() => frame(hp), 8000)));
    check("Crunchyroll: top page has no video", await hp.evaluate(() => !document.querySelector("video")));
  }
  check(`${s.name}: fixture player plays`, !!(await until(async () => { const v = await video(hp, s); return v && !v.paused && v.t > 0.3; }, 8000)));

  const made = await until(async () => { const x = await create(he, hp); return x.invite ? x : (await sleep(500), null); }, 12000);
  check(`${s.name}: Firefox creates a party`, !!made?.invite && !!keyOf(made.invite), JSON.stringify(made));
  if (!made?.invite) { await hp.close(); await gp.close(); continue; }
  await gp.goto(made.invite, { waitUntil: "domcontentloaded" });
  const body = await gp.evaluate(() => document.body.textContent);
  check(`${s.name}: invite page names the service`, body.includes(`Join on ${s.name}`), body.slice(0, 160));
  const href = await until(() => gp.evaluate(() => document.querySelector("a.btn")?.href || null), 8000);
  check(`${s.name}: invite links to the fixture episode`, s.invite.test(href || ""), href);
  await Promise.all([gp.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}), gp.evaluate(() => document.querySelector("a.btn").click())]);
  check(`${s.name}: Firefox guest joins through the invite`, !!(await until(async () => (await people(hp))?.length === 2 && (await people(gp))?.length === 2, 20000)));
  check(`${s.name}: invite key removed from address bar`, !/npParty|npKey/.test(gp.url()), gp.url());
  check(`${s.name}: guest player plays${s.frame ? " in its iframe" : ""}`, !!(await until(async () => { const v = await video(gp, s); return v && !v.paused && v.t > 0; }, 8000)));

  await act(hp, s, "pause");
  check(`${s.name}: host pause reaches guest`, !!(await until(async () => (await video(gp, s))?.paused, 8000)));
  await act(hp, s, "play", 40);
  const forward = await until(async () => { const [a, b] = await Promise.all([video(hp, s), video(gp, s)]); return a && b && !b.paused && a.t > 39 && near(a.t, b.t); }, 8000);
  check(`${s.name}: host seek and play reach guest`, !!forward, JSON.stringify([await video(hp, s), await video(gp, s)]));
  await act(gp, s, "seek", 70);
  const back = await until(async () => { const [a, b] = await Promise.all([video(hp, s), video(gp, s)]); return a && b && a.t > 69 && near(a.t, b.t); }, 8000);
  check(`${s.name}: guest seek reaches host`, !!back, JSON.stringify([await video(hp, s), await video(gp, s)]));
  await hp.close(); await gp.close();
}

check("no fixture page script errors", errors.length === 0, errors.join(" | "));
const failed = summary("FIREFOX PLATFORMS 2.2 (FIXTURES)");
await H.browser.close(); await G.browser.close(); T.close();
process.exit(failed ? 1 : 0);
