
// 2.2 platforms e2e: HBO Max (play.hbomax.com; play.max.com redirects there), Crunchyroll (its player is an
// iframe from static.crunchyroll.com, driven through the anyvideo.js agent) and SonyLIV (?watch=true player,
// Google IMA ad layer). All three are FIXTURES in fakesite.mjs built from the services' public URL shapes and
// page structure (we can't sign in to the real services): what passes here is verified against the fixtures only.
// Per service: popup detection, watch-page detection + content id, party start, invite page (names the service,
// links to the episode), guest join through the invite, play / pause / seek sync both ways, ads (no sync while
// one shows, catch up after), the title for GIF suggestions, the next episode moves the party, encrypted chat.
import { launch, shadow, until, status, people, check, summary, out, sleep } from "./lib.mjs";

const H = await launch("pw-plh", { name: "Chirag", avatar: "🦊" });
const G = await launch("pw-plg", { name: "Rahul", avatar: "🐼" });
const errors = [];
const watchPage = (p, n) => {
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  p.on("console", (m) => {
    if (m.type() === "error" && !/ERR_|status of 40|Failed to load resource/.test(m.text())) errors.push(n + " console: " + m.text());
    if (process.env.DEBUG) out(n + " console:", m.text().slice(0, 200));
  });
};
const create = (x, page) =>
  x.sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => t.url === u);
    return chrome.tabs.sendMessage(t.id, { cmd: "create" }).catch((e) => ({ error: String(e) }));
  }, page.url());
const stat = (x, page) =>
  x.sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => t.url === u);
    return t ? chrome.tabs.sendMessage(t.id, { cmd: "status" }).catch((e) => ({ error: String(e) })) : { error: "no tab " + u };
  }, page.url());
const near = (a, b, d = 1.5) => Math.abs(a - b) < d;

const SERVICES = [
  {
    name: "HBO Max",
    start: "https://play.max.com/video/watch/1f4b4570-933c-4264-b6e4-4aa9f596a9f5/a4f1e82b-a9f0-4e73-a692-35b31b9e0608",
    landed: /^https:\/\/play\.hbomax\.com\/video\/watch\/1f4b4570-933c-4264-b6e4-4aa9f596a9f5\/a4f1e82b-a9f0-4e73-a692-35b31b9e0608$/,
    off: "https://play.hbomax.com/",
    invite: /^https:\/\/play\.hbomax\.com\/video\/watch\/1f4b4570-933c-4264-b6e4-4aa9f596a9f5\/a4f1e82b-a9f0-4e73-a692-35b31b9e0608\?npParty=[a-z0-9]+#npKey=[\w-]{43}$/,
    title: "Fake HBO Episode 1",
    vid: async (p) => p.evaluate(() => { const v = document.querySelector("[data-testid=playerContainer] video"); return v ? { t: v.currentTime, paused: v.paused } : null; }),
    act: (p, fn) => p.evaluate(fn, null),
    v: () => document.querySelector("[data-testid=playerContainer] video"),
    ad: (p, on) => p.evaluate((on) => window.__hboAd(on), on),
    next: (p) => p.click("#hbonext"),
    nextUrl: /53efe792-9bd3-4e0c-b80e-87396b7ddcaf\/d98913ef/,
  },
  {
    name: "Crunchyroll",
    start: "https://www.crunchyroll.com/watch/GY0973WVY/the-talisman-woman",
    landed: /^https:\/\/www\.crunchyroll\.com\/watch\/GY0973WVY\/the-talisman-woman$/,
    off: "https://www.crunchyroll.com/",
    invite: /^https:\/\/www\.crunchyroll\.com\/watch\/GY0973WVY\?npParty=[a-z0-9]+#npKey=[\w-]{43}$/,
    title: "The Talisman Woman",
    frame: true,
    next: (p) => p.click("#crnext"),
    nextUrl: /\/watch\/G4PH0WXVJ/,
  },
  {
    name: "SonyLIV",
    start: "https://www.sonyliv.com/shows/bachelors-delight-1700000113/achaari-cheese-toast-1000022678",
    landed: /^https:\/\/www\.sonyliv\.com\/shows\/bachelors-delight-1700000113\/achaari-cheese-toast-1000022678\?watch=true$/,
    off: "https://www.sonyliv.com/",
    invite: /^https:\/\/www\.sonyliv\.com\/shows\/bachelors-delight-1700000113\/achaari-cheese-toast-1000022678\?watch=true&npParty=[a-z0-9]+#npKey=[\w-]{43}$/,
    title: "Achaari Cheese Toast",
    detailFirst: "#slwatch",
    v: () => document.querySelector(".playerContainer video"),
    ad: (p, on) => p.evaluate((on) => window.__slAd(on), on),
    next: (p) => p.click("#slnext"),
    nextUrl: /fake-sony-episode-2-1000022679/,
  },
  // 2.4
  {
    name: "Hulu",
    ver: "2.4",
    start: "https://www.hulu.com/watch/5f1e6a2c-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
    landed: /^https:\/\/www\.hulu\.com\/watch\/5f1e6a2c-3b4d-4e5f-8a9b-0c1d2e3f4a5b$/,
    off: "https://www.hulu.com/",
    invite: /^https:\/\/www\.hulu\.com\/watch\/5f1e6a2c-3b4d-4e5f-8a9b-0c1d2e3f4a5b\?npParty=[a-z0-9]+#npKey=[\w-]{43}$/,
    title: "Fake Hulu Episode 1",
    v: () => document.querySelector(".player video"),
    ad: (p, on) => p.evaluate((on) => window.__ad(on), on),
    next: (p) => p.click("#next24"),
    nextUrl: /\/watch\/7a2b3c4d-5e6f-4a1b-9c8d-7e6f5a4b3c2d$/,
  },
  {
    name: "Disney+",
    ver: "2.4",
    start: "https://www.disneyplus.com/play/e9fe54b5-9eb8-4298-8d72-f125d5b1aad1",
    landed: /^https:\/\/www\.disneyplus\.com\/play\/e9fe54b5-9eb8-4298-8d72-f125d5b1aad1$/,
    off: "https://www.disneyplus.com/",
    invite: /^https:\/\/www\.disneyplus\.com\/play\/e9fe54b5-9eb8-4298-8d72-f125d5b1aad1\?npParty=[a-z0-9]+#npKey=[\w-]{43}$/,
    title: "Fake Disney Movie",
    v: () => document.querySelector("fake-web-player")?.shadowRoot?.querySelector("video"),
    ad: (p, on) => p.evaluate((on) => window.__ad(on), on),
    next: (p) => p.click("#next24"),
    nextUrl: /\/play\/0b7c6d5e-4f3a-4b2c-8d1e-9f8a7b6c5d4e$/,
  },
  {
    name: "Paramount+",
    ver: "2.4",
    start: "https://www.paramountplus.com/shows/video/ALVE01M5AWA8K9EZZB3A56AC0VQQK1/",
    landed: /^https:\/\/www\.paramountplus\.com\/shows\/video\/ALVE01M5AWA8K9EZZB3A56AC0VQQK1\/$/,
    off: "https://www.paramountplus.com/",
    invite: /^https:\/\/www\.paramountplus\.com\/shows\/video\/ALVE01M5AWA8K9EZZB3A56AC0VQQK1\/\?npParty=[a-z0-9]+#npKey=[\w-]{43}$/,
    title: "Fake Paramount Episode 1",
    v: () => document.querySelector(".player video"),
    ad: (p, on) => p.evaluate((on) => window.__ad(on), on),
    next: (p) => p.click("#next24"),
    nextUrl: /\/shows\/video\/ALVE01M6P7EPS2E41SBYNNGPQJC6A7\/$/,
  },
  {
    name: "STARZ",
    ver: "2.4",
    start: "https://www.starz.com/us/en/play/62917",
    landed: /^https:\/\/www\.starz\.com\/us\/en\/play\/62917$/,
    off: "https://www.starz.com/",
    invite: /^https:\/\/www\.starz\.com\/us\/en\/play\/62917\?npParty=[a-z0-9]+#npKey=[\w-]{43}$/,
    title: "Fake Starz Episode 1",
    v: () => document.querySelector(".player video"),
    next: (p) => p.click("#next24"),
    nextUrl: /\/play\/62918$/,
  },
  {
    name: "Tubi",
    ver: "2.4",
    start: "https://tubitv.com/movies/605225/jack-and-jill",
    landed: /^https:\/\/tubitv\.com\/movies\/605225\/jack-and-jill$/,
    off: "https://tubitv.com/",
    invite: /^https:\/\/tubitv\.com\/movies\/605225\/jack-and-jill\?start=true&npParty=[a-z0-9]+#npKey=[\w-]{43}$/,
    title: "Jack and Jill (2011)",
    detailFirst: "#tbplay",
    v: () => document.querySelector(".player video"),
    ad: (p, on) => p.evaluate((on) => window.__ad(on), on),
    next: (p) => p.click("#next24"),
    nextUrl: /\/movies\/605226\/fake-tubi-movie-2$/,
  },
];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;
// Crunchyroll: the <video> lives in the player frame
const crFrame = (p) => p.frames().find((f) => /^https:\/\/static\.crunchyroll\.com\/vilos-v2\//.test(f.url()));
for (const S of SERVICES) {
  if (S.frame) {
    S.vid = async (p) => crFrame(p)?.evaluate(() => { const v = document.querySelector("video"); return v ? { t: v.currentTime, paused: v.paused } : null; }).catch(() => null);
    S.act = async (p, fn) => crFrame(p).evaluate((fs) => new Function("v", "return (" + fs + ")(v)")(document.querySelector("video")), fn.toString());
    S.ad = (p, on) => crFrame(p).evaluate((on) => window.__crAd(on), on);
  } else {
    const sel = S.v.toString();
    S.vid ||= (p) => p.evaluate((vs) => { const v = new Function("return (" + vs + ")()")(); return v ? { t: v.currentTime, paused: v.paused } : null; }, sel);
    S.act = (p, fn) => p.evaluate(([vs, fs]) => new Function("v", "return (" + fs + ")(v)")(new Function("return (" + vs + ")()")()), [sel, fn.toString()]);
  }
}

for (const S of SERVICES) {
  if (ONLY && !ONLY.test(S.name)) continue;
  out(`\n---- ${S.name}`);
  const hp = await H.ctx.newPage(), gp = await G.ctx.newPage();
  watchPage(hp, S.name + " host");
  watchPage(gp, S.name + " guest");
  // home page: on the service, not a watch page
  await hp.goto(S.off);
  await sleep(1200);
  const home = await stat(H, hp);
  check(`${S.name}: popup knows the service on its home page (not a watch page)`, home.site === S.name && home.onWatchPage === false, JSON.stringify(home));
  await hp.goto(S.start);
  if (S.detailFirst) {
    await sleep(1500);
    const det = await stat(H, hp);
    check(`${S.name}: the title page (no ?watch=true, small hero video) isn't a watch page`, det.onWatchPage === false, JSON.stringify(det));
    await hp.click(S.detailFirst);
  }
  await until(async () => S.landed.test(hp.url()), 8000);
  check(`${S.name}: lands on the watch page`, S.landed.test(hp.url()), hp.url());
  const w = await until(async () => { const s = await stat(H, hp); return s.onWatchPage ? s : null; }, 8000);
  check(`${S.name}: watch page detected`, !!w && w.site === S.name, JSON.stringify(w));
  check(`${S.name}: the video plays${S.frame ? " (in the player frame)" : ""}`, !!(await until(async () => { const v = await S.vid(hp); return v && !v.paused && v.t > 0.3; }, 8000)));
  // start the party (popup "Start a party")
  const made = await until(async () => { const r = await create(H, hp); return r?.invite ? r : (await sleep(800), null); }, 12000);
  check(`${S.name}: party starts (player found${S.frame ? " through the frame agent" : ""})`, !!made?.invite, JSON.stringify(made));
  if (!made?.invite) {
    await hp.close();
    await gp.close();
    continue;
  }
  // invite page
  await gp.goto(made.invite);
  const text = await gp.textContent("body");
  check(`${S.name}: invite page names the service and asks for ${S.ver || "2.2"}`, text.includes(`Join on ${S.name}`) && text.includes(`own ${S.name} account`) && text.includes(`${S.ver || "2.2"} or newer`), text.slice(0, 160));
  const href = await until(() => gp.getAttribute("a.btn", "href").then((h) => (h && h !== "#" ? h : null)), 5000);
  check(`${S.name}: invite links to the episode`, S.invite.test(href || ""), href);
  await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
  check(`${S.name}: guest joins through the invite`, !!(await until(async () => (await people(gp)).length === 2 && (await people(hp)).length === 2, 20000)));
  check(`${S.name}: invite code and key removed from the address bar`, !/npParty|npKey/.test(gp.url()), gp.url());
  await until(async () => (await S.vid(gp))?.t > 0, 8000);

  // sync: host pause / seek / play, then guest seek
  await S.act(hp, (v) => v.pause());
  check(`${S.name}: host pause → guest pauses`, !!(await until(async () => (await S.vid(gp))?.paused, 6000)));
  await S.act(hp, (v) => ((v.currentTime = 40), v.play()));
  await sleep(2500);
  let [a, b] = [await S.vid(hp), await S.vid(gp)];
  check(`${S.name}: host seek 40 s + play → guest follows`, !b.paused && a.t > 39 && near(a.t, b.t), `host ${a.t.toFixed(1)} guest ${b.t.toFixed(1)} ${b.paused}`);
  await S.act(gp, (v) => (v.currentTime = 70));
  await sleep(2500);
  [a, b] = [await S.vid(hp), await S.vid(gp)];
  check(`${S.name}: guest seek 70 s → host follows (both ways)`, a.t > 69 && near(a.t, b.t), `host ${a.t.toFixed(1)} guest ${b.t.toFixed(1)}`);

  // ads: the guest's player shows an ad (and jumps to the ad's time) → no sync, then catch up
  if (S.ad) {
    await S.ad(gp, true);
    await sleep(1300);
    const meta = await shadow(gp, (r) => { return r.querySelector(".np-meta")?.textContent || ""; });
    check(`${S.name}: ad detected (panel waits for it)`, /ad to finish/i.test(meta), meta);
    const before = (await S.vid(hp)).t;
    await sleep(1500);
    check(`${S.name}: the ad's position isn't pushed to the host`, near((await S.vid(hp)).t - before, 1.5, 1.2), `host ${(await S.vid(hp)).t.toFixed(1)}`);
    await S.ad(gp, false);
    await S.act(gp, (v) => (v.currentTime = 5));
    await sleep(3000);
    [a, b] = [await S.vid(hp), await S.vid(gp)];
    check(`${S.name}: after the ad the guest catches up`, near(a.t, b.t), `host ${a.t.toFixed(1)} guest ${b.t.toFixed(1)}`);
  }

  // title (GIF suggestions use it)
  const ttl = await until(async () => (await stat(H, hp)).title || null, 4000);
  check(`${S.name}: title read from the page ("${S.title}")`, ttl === S.title, String(ttl));

  // chat
  await gp.locator(".np-input").click();
  await gp.keyboard.type(`hello from ${S.name}`);
  await gp.keyboard.press("Enter");
  check(`${S.name}: chat works and site hotkeys don't fire`, !!(await until(() => shadow(hp, (r) => { return [...r.querySelectorAll(".np-bubble")].some((b) => b.firstChild?.textContent === a); }, `hello from ${S.name}`), 6000)) && (await gp.evaluate(() => window.__hotkeys)) === 0);

  // docked panel: the player isn't under the chat
  if (!S.frame) {
    const lay = await hp.evaluate(() => {
      const p = document.getElementById("netparty-root").shadowRoot.querySelector(".np-panel").getBoundingClientRect();
      const s = document.querySelector("[data-np-shrink]")?.getBoundingClientRect();
      return { panelLeft: Math.round(p.left), boxRight: s ? Math.round(s.right) : null };
    });
    check(`${S.name}: docked chat narrows the player box`, lay.boxRight !== null && lay.boxRight <= lay.panelLeft + 1, JSON.stringify(lay));
  } else {
    const lay = await hp.evaluate(() => {
      const p = document.getElementById("netparty-root").shadowRoot.querySelector(".np-panel").getBoundingClientRect();
      const f = document.querySelector("iframe.video-player").getBoundingClientRect();
      return { panelLeft: Math.round(p.left), frameRight: Math.round(f.right), shrunk: !!document.querySelector("[data-np-shrink]") };
    });
    check(`${S.name}: docked chat narrows the box around the player frame`, lay.shrunk && lay.frameRight <= lay.panelLeft + 1, JSON.stringify(lay));
  }
  await hp.screenshot({ path: `pl-${S.name.replace(/\W/g, "").toLowerCase()}.png` });

  // the host goes to the next episode: the party follows
  await S.next(hp);
  check(`${S.name}: next episode moves the guest too`, !!(await until(async () => S.nextUrl.test(gp.url()) && (await people(gp)).length === 2, 25000)), gp.url());
  check(`${S.name}: and the guest's player plays the new episode in sync`, !!(await until(async () => { const [x, y] = [await S.vid(hp), await S.vid(gp)]; return x && y && !y.paused && near(x.t, y.t, 2); }, 12000)));

  // leaving the watch page ends the party for the host
  await hp.goto(S.off);
  await sleep(500);
  check(`${S.name}: guest is told when the host leaves`, !!(await until(async () => !(await stat(G, gp)).roomId, 15000)));
  await hp.close();
  await gp.close();
}

// Crunchyroll: a language prefix in the address (/fr/watch/<id>/…) is the same episode
{
  const p = await H.ctx.newPage();
  await p.goto("https://www.crunchyroll.com/fr/watch/GY0973WVY/the-talisman-woman");
  const s = await until(async () => { const x = await stat(H, p); return x.onWatchPage ? x : null; }, 8000);
  check("Crunchyroll: /fr/watch/<id>/… is a watch page", !!s);
  await p.close();
}

// popup site detection
const pop = await H.ctx.newPage();
await pop.goto(`chrome-extension://${H.sw.url().split("/")[2]}/popup.html`);
const det = await pop.evaluate(() =>
  ["https://play.hbomax.com/video/watch/x", "https://play.max.com/", "https://www.crunchyroll.com/watch/X", "https://static.crunchyroll.com/vilos-v2/web/vilos/player.html", "https://www.sonyliv.com/movies/x-1", "https://sonyliv.com/", "https://www.hbomax.com/", "http://www.sonyliv.com/",
    "https://www.hulu.com/watch/x", "https://www.disneyplus.com/play/x", "https://www.paramountplus.com/", "https://www.starz.com/us/en/play/1", "https://tubitv.com/movies/1", "https://www.tubitv.com/", "https://hulu.com/", "https://disneyplus.com/", "http://tubitv.com/"].map(supportedSite),
);
check("popup site detection: the 2.2 and 2.4 services' own hosts only", JSON.stringify(det) === "[true,true,true,false,true,false,false,false,true,true,true,true,true,true,false,false,false]", JSON.stringify(det));
// 2.4: the popup's "or open" list is Netflix, JioHotstar, Prime Video and YouTube, each with its icon
const offList = await pop.evaluate(() => [...document.querySelectorAll("#vOff [data-open]")].map((b) => b.textContent.trim() + (b.querySelector("img")?.complete && b.querySelector("img").naturalWidth > 0 ? "+icon" : "")).join(","));
check("popup lists Netflix, JioHotstar, Prime Video, YouTube with icons", offList === "Netflix+icon,JioHotstar+icon,Prime Video+icon,YouTube+icon", offList);
await pop.close();

check("no script errors", errors.length === 0, errors.join(" | "));
const f = summary("PLATFORMS 2.2 + 2.4");
await H.ctx.close();
await G.ctx.close();
process.exit(f ? 1 : 0);
