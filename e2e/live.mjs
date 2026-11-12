// 2.5 live streams e2e: YouTube live, Twitch, Kick and Rumble on FIXTURES (fakesite.mjs: one fake broadcast in 2 s
// WebM segments, played through Media Source Extensions, so every viewer's player has its own buffer and delay
// behind live; the stream's own time is the same for everyone, so true sync is checked by comparing currentTime).
// The real services aren't tested (we can't play their streams here).
// Per service: watch page and live id, party start, invite page (2.5, no account needed), join, the party lines up
// a viewer who starts further behind, pause / play, a rewind on a player that can (Rumble, YouTube), Go live,
// another stream moves the party, a player that jumps to the live edge by itself is left alone, chat.
import { launch, shadow, until, people, check, summary, out, sleep } from "./lib.mjs";

const errors = [];
const watchPage = (p, n) => {
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  p.on("console", (m) => {
    if (m.type() === "error" && !/ERR_|status of 40|Failed to load resource/.test(m.text())) errors.push(n + " console: " + m.text());
    if (process.env.DEBUG && /NetParty|livesim/.test(m.text())) out(n + " console:", m.text().slice(0, 200));
  });
};
const toTab = (x, page, msg) =>
  x.sw.evaluate(async ([u, msg]) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => t.url === u);
    return t ? chrome.tabs.sendMessage(t.id, msg).catch((e) => ({ error: String(e) })) : { error: "no tab " + u };
  }, [page.url(), msg]);
const stat = (x, p) => toTab(x, p, { cmd: "status" });
const info = (p) => p.evaluate(() => (window.__liveInfo ? window.__liveInfo() : null)).catch(() => null);
const both = async (a, b) => {
  const [x, y] = await Promise.all([info(a), info(b)]);
  return x && y ? { dt: x.t - y.t, a: x, b: y } : null;
};
const fixed = (n) => (n == null ? "?" : n.toFixed(1));
// cookies for a site's fake player in one browser (see livePlayer in fakesite.mjs)
const cookies = (x, domain, o) =>
  x.ctx.addCookies(Object.entries(o).map(([k, v]) => ({ name: "npl_" + k, value: String(v), domain, path: "/", secure: true, sameSite: "Lax" })));
const clearCookies = (x) => x.ctx.clearCookies();
const inSync = async (hp, gp, ms = 25000, tol = 1.5) => until(async () => { const s = await both(hp, gp); return s && !s.a.paused && !s.b.paused && Math.abs(s.dt) < tol ? s : null; }, ms, 500);

const H = await launch("pw-lvh", { name: "Chirag", avatar: "🦊" });
const G = await launch("pw-lvg", { name: "Rahul", avatar: "🐼" });

// the fake broadcast needs to have been on for a while (a rewind window, and room to be behind)
{
  const p = await H.ctx.newPage();
  await p.goto("https://www.twitch.tv/");
  const clk = await p.evaluate(() => fetch("/livesim/clock").then((r) => r.json()));
  const wait = Math.max(0, 100000 - (clk.now - clk.t0));
  out(`broadcast on for ${Math.round((clk.now - clk.t0) / 1000)} s; waiting ${Math.round(wait / 1000)} s for a 100 s window`);
  await sleep(wait);
  await p.close();
}

const SERVICES = [
  { name: "Twitch", host: "www.twitch.tv", start: "https://www.twitch.tv/fakestreamer", id: "tw:fakestreamer", invite: /^https:\/\/www\.twitch\.tv\/fakestreamer\?npParty=[a-z0-9]+#npKey=[\w-]{43}$/, title: "Fake Twitch Stream", other: /\/otherchan$/, otherId: "tw:otherchan" },
  { name: "Kick", host: "kick.com", start: "https://kick.com/fakekicker", id: "kk:fakekicker", invite: /^https:\/\/kick\.com\/fakekicker\?npParty=[a-z0-9]+#npKey=[\w-]{43}$/, title: "Fake Kick Stream", other: /\/other-kicker$/, otherId: "kk:other-kicker", snapTest: true },
  { name: "Rumble", host: "rumble.com", start: "https://rumble.com/v6abc12-fake-live-show.html", id: "rl:v6abc12-fake-live-show", invite: /^https:\/\/rumble\.com\/v6abc12-fake-live-show\.html\?npParty=[a-z0-9]+#npKey=[\w-]{43}$/, title: "Fake Rumble Live Show", dvr: true, other: /\/v6abc13-second-live-show\.html$/, otherId: "rl:v6abc13-second-live-show" },
  { name: "YouTube", host: "www.youtube.com", start: "https://www.youtube.com/live/LIVEstream1", id: "yl:LIVEstream1", invite: /^https:\/\/www\.youtube\.com\/watch\?v=LIVEstream1&npParty=[a-z0-9]+#npKey=[\w-]{43}$/, title: "Fake Live Stream", dvr: true, yt: true },
];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;

for (const S of SERVICES) {
  if (ONLY && !ONLY.test(S.name)) continue;
  out(`\n---- ${S.name}`);
  await clearCookies(H);
  await clearCookies(G);
  // the host's player starts 9 s behind the newest media, the guest's 2 s: on joining the guest has to wait (or,
  // on a player that can rewind, jump back) to the party's delay
  // (Kick: the host keeps 40 s of the stream behind where it plays, for the snap test below)
  await cookies(H, S.host, { behind: 9, ...(S.snapTest ? { keep: 40 } : {}) });
  await cookies(G, S.host, { behind: 2 });
  const hp = await H.ctx.newPage(), gp = await G.ctx.newPage();
  watchPage(hp, S.name + " host");
  watchPage(gp, S.name + " guest");
  await hp.goto(S.start);
  // (YouTube and Rumble: the page takes a moment to show the stream is live)
  const w = await until(async () => { const s = await stat(H, hp); return s.onWatchPage && s.videoId === S.id ? s : null; }, 15000);
  check(`${S.name}: live watch page, id ${S.id}`, w?.videoId === S.id && w.site === S.name, JSON.stringify(w && { id: w.videoId, site: w.site }));
  check(`${S.name}: title read ("${S.title}")`, w?.title === S.title, w?.title);
  await until(async () => (await info(hp))?.t > 0, 8000);
  const made = await until(async () => { const r = await toTab(H, hp, { cmd: "create" }); return r?.invite ? r : (await sleep(800), null); }, 20000);
  check(`${S.name}: party starts`, !!made?.invite, JSON.stringify(made));
  if (!made?.invite) {
    await hp.close();
    await gp.close();
    continue;
  }
  const hs = await stat(H, hp);
  check(`${S.name}: it's a live party (the host's delay is known)`, hs.live && Number.isFinite(hs.live.delay) && hs.live.dvr === !!S.dvr, JSON.stringify(hs.live));

  // invite page: the service, 2.5, no account needed
  await gp.goto(made.invite);
  const text = await gp.textContent("body");
  check(`${S.name}: invite page names the service and asks for 2.5, no account`, text.includes(`Join on ${S.name}`) && text.includes("2.5 or newer") && !text.includes(`own ${S.name} account`), text.slice(0, 120));
  const href = await until(() => gp.getAttribute("a.btn", "href").then((h) => (h && h !== "#" ? h : null)), 5000);
  check(`${S.name}: invite links to the stream`, S.invite.test(href || ""), href);
  await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
  check(`${S.name}: guest joins`, !!(await until(async () => (await people(gp)).length === 2 && (await people(hp)).length === 2, 25000)));
  const before = await both(hp, gp);
  out(`  before lining up: host ${fixed(before?.a.t)} guest ${fixed(before?.b.t)} (Δ ${fixed(before?.dt)} s)`);

  const s1 = await inSync(hp, gp, 30000);
  check(`${S.name}: the guest, closer to live, lines up with the party (Δ < 1.5 s)`, !!s1, s1 ? `Δ ${fixed(s1.dt)} s` : JSON.stringify(await both(hp, gp)));
  await sleep(6000);
  const s1b = await both(hp, gp);
  check(`${S.name}: and stays lined up (no chasing)`, !!s1b && Math.abs(s1b.dt) < 1.5 && !s1b.a.paused && !s1b.b.paused, s1b ? `Δ ${fixed(s1b.dt)} s` : "");

  // the host's player falls 4 s behind by itself (a stall): the guest hears it and waits for the host
  await hp.evaluate(() => { const v = document.querySelector("video#lv, #movie_player video"); v.currentTime = Math.max(v.buffered.start(0) + 0.5, v.currentTime - 4); });
  const fell = await both(hp, gp);
  out(`  host fell behind: Δ ${fixed(fell?.dt)} s`);
  const s1c = await inSync(hp, gp, 20000);
  check(`${S.name}: a viewer who falls behind is waited for (Δ < 1.5 s)`, !!s1c, s1c ? `Δ ${fixed(s1c.dt)} s` : JSON.stringify(await both(hp, gp)));

  // pause / play
  await hp.evaluate(() => document.querySelector("video#lv, #movie_player video").pause());
  check(`${S.name}: host pauses → guest pauses`, !!(await until(async () => (await info(gp))?.paused, 6000)));
  await sleep(3000);
  await hp.evaluate(() => document.querySelector("video#lv, #movie_player video").play());
  check(`${S.name}: host plays → guest plays`, !!(await until(async () => (await info(gp))?.paused === false, 6000)));
  const s2 = await inSync(hp, gp, 20000);
  check(`${S.name}: in sync after the pause`, !!s2, s2 ? `Δ ${fixed(s2.dt)} s` : JSON.stringify(await both(hp, gp)));

  // a rewind (players that can): the guest jumps back 30 s, the host follows
  if (S.dvr) {
    await gp.evaluate(() => { const v = document.querySelector("video#lv, #movie_player video"); v.currentTime -= 30; });
    const s3 = await until(async () => { const s = await both(hp, gp); return s && Math.abs(s.dt) < 1.5 && s.a.edge - s.a.t > 25 ? s : null; }, 15000, 500);
    check(`${S.name}: guest rewinds 30 s → the host follows`, !!s3, s3 ? `Δ ${fixed(s3.dt)} s, host ${fixed(s3.a.edge - s3.a.t)} s behind` : JSON.stringify(await both(hp, gp)));
  } else {
    // can't rewind: the guest's seek isn't sent to the party (the player jumps about by itself)
    const hb = (await info(hp)).t;
    await gp.evaluate(() => { const v = document.querySelector("video#lv"); v.currentTime = Math.max(v.buffered.start(0), v.currentTime - 4); });
    await sleep(2500);
    check(`${S.name}: a seek on a player that can't rewind isn't pushed to the host`, (await info(hp)).t - hb > 1.5, `host moved ${fixed((await info(hp)).t - hb)} s in 2.5 s`);
  }

  // Go live: the host is well behind (after the rewind / the waits): everyone to the live edge
  if (S.dvr) {
    const bar = await until(() => shadow(hp, (r) => { const b = r.querySelector(".np-live"); return b && !b.hidden && !r.querySelector(".np-golive").hidden ? b.textContent : null; }), 8000);
    check(`${S.name}: host sees how far behind live and Go live`, /behind live/.test(bar || ""), bar);
    await shadow(hp, (r) => { r.querySelector(".np-golive").click(); return true; });
    const s4 = await until(async () => { const s = await both(hp, gp); return s && Math.abs(s.dt) < 1.5 && s.a.edge - s.a.t < 4 && s.b.edge - s.b.t < 4 ? s : null; }, 15000, 500);
    check(`${S.name}: Go live → both at the live edge, in sync`, !!s4, s4 ? `Δ ${fixed(s4.dt)} s, host ${fixed(s4.a.edge - s4.a.t)} s guest ${fixed(s4.b.edge - s4.b.t)} s behind` : JSON.stringify(await both(hp, gp)));
    const sys = await shadow(gp, (r) => { return [...r.querySelectorAll(".np-sys")].map((n) => n.textContent).join(" | "); });
    check(`${S.name}: the guest's chat says the host jumped to live`, /jumped to live/.test(sys), sys.slice(-120));
  }

  // chat
  await gp.locator(".np-input").click();
  await gp.keyboard.type(`hi from ${S.name} live`);
  await gp.keyboard.press("Enter");
  check(`${S.name}: chat works, site hotkeys don't fire`, !!(await until(() => shadow(hp, (r) => { return [...r.querySelectorAll(".np-bubble")].some((b) => b.firstChild?.textContent === a); }, `hi from ${S.name} live`), 6000)) && (await gp.evaluate(() => window.__hotkeys)) === 0);

  // another stream: the guest follows
  if (S.other) {
    await hp.click("#other");
    check(`${S.name}: host switches stream → guest follows`, !!(await until(async () => S.other.test(gp.url()) && (await people(gp)).length === 2, 25000)), gp.url());
    const st = await until(async () => { const s = await stat(G, gp); return s.videoId === S.otherId ? s : null; }, 10000);
    check(`${S.name}: …and it's still a live party there`, !!st?.live, JSON.stringify(st?.live));
  }
  await hp.screenshot({ path: `live-${S.name.toLowerCase()}.png` });

  // a player that jumps back to the live edge whenever it resumes: NetParty stops waiting after two tries
  if (S.snapTest) {
    // the guest leaves properly (a tab that just closes would pause the party until it's back)
    // (and the party doesn't wait for loading videos here: a resume would take the host back to the party's delay)
    await H.sw.evaluate(() => chrome.storage.sync.set({ syncWait: false }));
    await toTab(G, gp, { cmd: "leave" });
    await gp.close();
    await clearCookies(G);
    await cookies(G, S.host, { behind: 1, snap: 1, keep: 5 });
    const gp2 = await G.ctx.newPage();
    watchPage(gp2, S.name + " snap guest");
    // (the host is still on the other stream: rejoin there with the same invite). The party pauses for 10 s and plays
    // on, so it watches about 10 s further behind live: more than the guest's player keeps behind (5 s), so the guest has to
    // wait (pause), and its player snaps back to live each time it resumes
    const inv = (await stat(H, hp)).invite;
    await sleep(3000); // (the host's player on the new stream settles first)
    await hp.evaluate(() => document.querySelector("video#lv").pause());
    await sleep(10000);
    await hp.evaluate(() => document.querySelector("video#lv").play());
    await sleep(1500);
    const hd = (await stat(H, hp)).live?.delay;
    check(`${S.name}: after a 10 s pause the party watches well behind live`, hd > 9000, String(hd));
    await gp2.goto(inv);
    await Promise.all([gp2.waitForNavigation(), gp2.click("a.btn")]);
    await until(async () => (await people(gp2)).length === 2, 25000);
    const gave = await until(async () => { const s = await stat(G, gp2); return s.live?.stuckAhead ? s : null; }, 90000, 1000);
    check(`${S.name}: a player that snaps back to live is left alone after two tries`, !!gave, JSON.stringify((await stat(G, gp2)).live));
    const note = await shadow(gp2, (r) => { return r.querySelector(".np-live")?.textContent || ""; });
    check(`${S.name}: …and the guest is told why they may be ahead`, /keeps itself at the live edge/.test(note), note);
    let pauses = 0;
    await gp2.evaluate(() => { window.__pauses = 0; document.querySelector("video#lv").addEventListener("pause", () => window.__pauses++); });
    await sleep(15000);
    pauses = await gp2.evaluate(() => window.__pauses);
    check(`${S.name}: …no more waits (no stutter)`, pauses === 0, `${pauses} pauses in 15 s`);
    await gp2.close();
    await H.sw.evaluate(() => chrome.storage.sync.remove("syncWait"));
  } else await gp.close();

  // leaving ends it
  await hp.goto(`https://${S.host}/`);
  await hp.close();
}

// popup: the live sites count as supported sites
{
  const pop = await H.ctx.newPage();
  await pop.goto(`chrome-extension://${H.sw.url().split("/")[2]}/popup.html`);
  const det = await pop.evaluate(() =>
    ["https://www.twitch.tv/x", "https://kick.com/x", "https://www.kick.com/x", "https://rumble.com/v1-x.html", "https://twitch.tv/x", "https://m.twitch.tv/x", "http://kick.com/", "https://www.rumble.com/"].map(supportedSite),
  );
  check("popup site detection: www.twitch.tv, kick.com, www.kick.com, rumble.com only", JSON.stringify(det) === "[true,true,true,true,false,false,false,false]", JSON.stringify(det));
  const offList = await pop.evaluate(() => [...document.querySelectorAll("#vOff [data-open]")].map((b) => b.textContent.trim()).join(","));
  check("popup's open list is still the four services", offList === "Netflix,JioHotstar,Prime Video,YouTube", offList);
  await pop.close();
}
// an ordinary YouTube video starts its party straight away (no waiting to see whether it's live)
{
  const p = await H.ctx.newPage();
  await p.goto("https://www.youtube.com/watch?v=aaaaaaaaaaa");
  await until(async () => (await stat(H, p)).onWatchPage, 10000);
  await sleep(1500);
  const t0 = Date.now();
  const r = await toTab(H, p, { cmd: "create" });
  const ms = Date.now() - t0;
  const s = await stat(H, p);
  check("YouTube: an ordinary video starts an ordinary party without waiting", !!r.invite && ms < 3000 && s.videoId === "yt:aaaaaaaaaaa" && !s.live, `${ms} ms ${s.videoId}`);
  await toTab(H, p, { cmd: "leave" });
  await p.close();
}
// Rumble videos that aren't live are ordinary parties
{
  const p = await H.ctx.newPage();
  await p.goto("https://rumble.com/v4xyz9-old-video.html");
  const s = await until(async () => { const x = await stat(H, p); return x.onWatchPage && x.videoId?.startsWith("rb:") ? x : null; }, 20000);
  check("Rumble: a video that isn't live is an ordinary party (rb:)", s?.videoId === "rb:v4xyz9-old-video", JSON.stringify(s && s.videoId));
  await p.close();
}

check("no script errors", errors.length === 0, errors.join(" | "));
const f = summary("LIVE 2.5");
await H.ctx.close();
await G.ctx.close();
process.exit(f ? 1 : 0);
