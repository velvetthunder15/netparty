// YouTube e2e (fake youtube.com with a Trusted Types CSP): Start button on the watch page,
// invite → join, play/pause/seek sync, ads (no sync during an ad, catch up after),
// video change moves the party, docked layout in default / theater / fullscreen, leaving ends it.
import { launch, shadow, until, status, people, check, summary, out, sleep, SERVER } from "./lib.mjs";

const H = await launch("/tmp/pw-yh", { name: "Chirag", avatar: "🦊" });
const G = await launch("/tmp/pw-yg", { name: "Rahul", avatar: "🐼" });
const hp = await H.ctx.newPage(), gp = await G.ctx.newPage();
const errors = [];
for (const [p, n] of [[hp, "host"], [gp, "guest"]]) {
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  p.on("console", (m) => {
    if (m.type() === "error" || /TrustedHTML|Trusted Type/i.test(m.text())) errors.push(n + " console: " + m.text());
    if (process.env.DEBUG) out(n + " console:", m.text().slice(0, 200));
  });
}
const vid = (p) => p.evaluate(() => { const v = document.querySelector("#movie_player video"); return { t: v.currentTime, paused: v.paused }; });

// 1. Start a NetParty under the video
await hp.goto("https://www.youtube.com/watch?v=aaaaaaaaaaa");
const btn = await until(() => hp.$("[data-netparty-start]"), 8000);
check("Start a NetParty button on the watch page", !!btn);
const geo = await hp.evaluate(() => {
  const b = document.querySelector("[data-netparty-start]"), like = document.querySelector("#likebtn");
  const r = (n) => n.getBoundingClientRect();
  return { inRow: b.parentElement.id, first: b.parentElement.firstElementChild === b, h: Math.round(r(b).height), likeH: Math.round(r(like).height), before: r(b).right <= r(like).left, top: Math.round(r(b).top) === Math.round(r(like).top) };
});
check("button sits in the actions row before Like, same height", geo.inRow === "top-level-buttons-computed" && geo.first && geo.before && geo.top && geo.h === geo.likeH, JSON.stringify(geo));
await hp.screenshot({ path: "yt-start-button.png" });
await btn.click();
const hst = await until(async () => { const s = await status(H, hp); return s?.roomId ? s : null; }, 15000);
check("click starts the party right away", !!hst?.roomId && hst.site === "YouTube", JSON.stringify(hst));
check("chat panel opens docked", !!(await until(() => hp.evaluate(() => document.documentElement.classList.contains("np-docked")))));
check("start button removed while in a party", !!(await until(async () => !(await hp.$("[data-netparty-start]")), 4000)));

// 2. guest joins with the invite link
await gp.goto(hst.invite);
const inviteText = await gp.textContent("body");
check("invite page names YouTube", /Join on YouTube/.test(inviteText) && !/Netflix/.test(inviteText));
const joinHref = await gp.getAttribute("a.btn", "href");
check("invite links to the YouTube watch page", /^https:\/\/www\.youtube\.com\/watch\?v=aaaaaaaaaaa&npParty=/.test(joinHref), joinHref);
await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
check("guest joins", !!(await until(async () => (await people(gp)).length === 2, 20000)));
check("invite code removed from the address bar", !/npParty/.test(gp.url()) && /v=aaaaaaaaaaa/.test(gp.url()), gp.url());

// 3. playback sync through the HTML5 <video> in #movie_player
await hp.evaluate(() => document.querySelector("#movie_player video").pause());
check("host pause → guest pauses", !!(await until(async () => (await vid(gp)).paused, 5000)));
await hp.evaluate(() => { const v = document.querySelector("#movie_player video"); v.currentTime = 30; v.play(); });
await sleep(2500);
const [h3, g3] = [await vid(hp), await vid(gp)];
check("host seek + play → guest follows", !g3.paused && Math.abs(h3.t - g3.t) < 1.5, `host ${h3.t.toFixed(1)} guest ${g3.t.toFixed(1)}`);
// typing in chat must not trigger YouTube's k/j/l/space hotkeys
await gp.locator(".np-input").click();
await gp.keyboard.type("k j l f m  ok");
await gp.keyboard.press("Enter");
check("YouTube hotkeys don't fire while typing in chat", (await gp.evaluate(() => window.__hotkeys)) === 0, String(await gp.evaluate(() => window.__hotkeys)));

// 4. ads: the guest gets an ad
await gp.evaluate(() => window.__ad(true));
check("guest sees 'Waiting for ad to finish'", !!(await until(() => shadow(gp, (r) => { return /Waiting for ad to finish/.test(r.querySelector(".np-meta").textContent); }), 4000)));
await sleep(1500);
const hAd = await vid(hp);
check("the guest's ad doesn't move the host", !hAd.paused && hAd.t < 60, JSON.stringify(hAd));
await hp.evaluate(() => { const v = document.querySelector("#movie_player video"); v.pause(); v.currentTime = 50; });
await sleep(2000);
const gAd = await vid(gp);
check("during the ad the guest isn't synced (ad keeps playing)", !gAd.paused && gAd.t >= 100, JSON.stringify(gAd));
await gp.evaluate(() => window.__ad(false));
const caught = await until(async () => { const v = await vid(gp); return v.paused && Math.abs(v.t - 50) < 1.5 && v; }, 6000);
check("after the ad the guest catches up (paused at 50 s like the host)", !!caught, JSON.stringify(await vid(gp)));
const hAfter = await vid(hp);
check("ad end didn't push the guest's position to the party", hAfter.paused && Math.abs(hAfter.t - 50) < 1, JSON.stringify(hAfter));
check("meta back to normal", !!(await until(() => shadow(gp, (r) => { return /Paused/.test(r.querySelector(".np-meta").textContent); }), 3000)));
await hp.evaluate(() => document.querySelector("#movie_player video").play());
await sleep(1200);

// 5. host switches video (SPA): the party moves, guest follows
await hp.click("#next");
check("host URL is the next video", !!(await until(() => /v=bbbbbbbbbbb/.test(hp.url()), 5000)), hp.url());
const followed = await until(async () => /v=bbbbbbbbbbb/.test(gp.url()) && (await people(gp)).length === 2, 20000);
check("guest follows to the new video, still in the party", !!followed, gp.url());
const hs2 = await status(H, hp);
check("same party, host still host", hs2.roomId === hst.roomId && hs2.isHost);
check("host told the party moved to the new video", !!(await until(() => shadow(hp, (r) => { return [...r.querySelectorAll(".np-sys")].some((n) => /Moved the party to a new video/.test(n.textContent)); }), 5000)));

// 6. docked layout: the player box narrows, the video is never cropped
const layout = (p) => p.evaluate(() => {
  const r = (n) => n.getBoundingClientRect();
  const v = r(document.querySelector("#movie_player video")), mp = r(document.querySelector("#movie_player"));
  const panel = document.getElementById("netparty-root").shadowRoot.querySelector(".np-panel").getBoundingClientRect();
  const mh = document.querySelector("#masthead-container");
  const R = (x) => Math.round(x);
  return {
    vw: innerWidth, panelLeft: R(panel.left), panelW: R(panel.width), playerRight: R(mp.right), videoL: R(v.left), videoR: R(v.right), videoW: R(v.width), videoH: R(v.height),
    videoInPlayer: v.left >= mp.left - 1 && v.right <= mp.right + 1 && v.top >= mp.top - 1 && v.bottom <= mp.bottom + 1,
    mastheadRight: mh && getComputedStyle(mh).display !== "none" ? R(r(mh).right) : null,
    fs: !!document.fullscreenElement, docked: document.documentElement.classList.contains("np-docked"),
  };
});
const okLayout = (l) => l.docked && l.panelLeft === l.vw - l.panelW && l.playerRight <= l.panelLeft + 1 && l.videoR <= l.panelLeft + 1 && l.videoInPlayer && l.videoW > 200 && (l.mastheadRight === null || l.mastheadRight <= l.panelLeft + 1);
await sleep(800);
const L1 = await layout(gp);
check("default layout: player and top bar end where the chat begins, video whole", okLayout(L1), JSON.stringify(L1));
await gp.screenshot({ path: "yt-docked.png" });
await gp.evaluate(() => window.__theater(true));
await sleep(800);
const L2 = await layout(gp);
check("theater mode: same, and the video got bigger", okLayout(L2) && L2.videoW > L1.videoW, JSON.stringify(L2));
await gp.screenshot({ path: "yt-theater.png" });
await gp.click("#fsbtn");
await sleep(1000);
const L3 = await layout(gp);
check("fullscreen (on <ytd-app>): overlay inside it, docked layout holds", L3.fs && okLayout(L3), JSON.stringify(L3));
check("overlay lives in the fullscreen element", await gp.evaluate(() => document.fullscreenElement?.contains(document.getElementById("netparty-root"))));
await gp.screenshot({ path: "yt-fullscreen.png" });
await gp.evaluate(() => document.exitFullscreen());
await sleep(700);
await gp.evaluate(() => window.__theater(false));
await shadow(gp, (r) => { r.querySelector(".np-close").click(); });
await sleep(600);
const L4 = await gp.evaluate(() => ({ vw: innerWidth, mp: Math.round(document.querySelector("#movie_player").getBoundingClientRect().right), shrink: document.querySelectorAll("[data-np-shrink]").length, docked: document.documentElement.classList.contains("np-docked") }));
check("chat hidden: page back to full width", !L4.docked && L4.mp > L1.playerRight, JSON.stringify(L4));

// 7. reactions float on YouTube too
await hp.locator('.np-tool[aria-label="Reactions"]').click();
await hp.locator('.np-react-btn[data-emoji="😱"]').click();
check("reaction floats on the guest's YouTube", !!(await until(() => shadow(gp, (r) => { return r.querySelector(".np-fly")?.textContent === "😱"; }), 3000, 50)));

// 8. host goes back to the YouTube home page: party ends
await hp.evaluate(() => window.__go("/"));
await sleep(4500);
const hs4 = await status(H, hp);
check("host leaving the watch page ends the party", !hs4.roomId);
const gs4 = await until(async () => { const s = await status(G, gp); return !s.roomId ? s : null; }, 8000);
check("guest is out too", !!gs4);
check("no start button on the home page", !(await hp.$("[data-netparty-start]")));
await hp.evaluate(() => window.__go("/watch?v=aaaaaaaaaaa"));
check("start button comes back on a watch page", !!(await until(() => hp.$("[data-netparty-start]"), 5000)));

check("no script / Trusted Types errors", errors.length === 0, errors.join(" | "));
const f = summary("YOUTUBE");
await H.ctx.close();
await G.ctx.close();
process.exit(f ? 1 : 0);
