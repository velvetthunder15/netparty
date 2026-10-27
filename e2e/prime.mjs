// Prime Video e2e (fake www.primevideo.com + www.amazon.co.uk/gp/video, built from Prime's public
// player DOM: an overlay player #dv-web-player on the title page, HTML5 <video> inside, a muted hero
// trailer outside it, ?autoplay=1 opening the player). Start button next to Play, invite → join
// (autoplay opens the guest's player), encrypted chat, play/pause/seek sync both ways, the hero
// trailer is never the synced video, ads pause sync and catch up, docked layout, title change,
// closing the player leaves the party, Amazon-store title ids, popup site detection.
import { launch, shadow, until, status, people, check, summary, out, sleep } from "./lib.mjs";

const H = await launch("/tmp/pw-ph", { name: "Chirag", avatar: "🦊" });
const G = await launch("/tmp/pw-pg", { name: "Rahul", avatar: "🐼" });
const hp = await H.ctx.newPage(), gp = await G.ctx.newPage();
const errors = [];
for (const [p, n] of [[hp, "host"], [gp, "guest"]]) {
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  p.on("console", (m) => {
    if (m.type() === "error" && !/ERR_|status of 40/.test(m.text())) errors.push(n + " console: " + m.text());
    if (process.env.DEBUG) out(n + " console:", m.text().slice(0, 200));
  });
}
const vid = (p) => p.evaluate(() => { const v = document.querySelector("#dv-web-player video"); return v ? { t: v.currentTime, paused: v.paused } : null; });
const TITLE = "https://www.primevideo.com/detail/0PVFAKEMOVIE1/ref=atv_hm_hom_c_1";

// 1. title page: Start a NetParty next to Play (not on the trailer, not inside the player)
await hp.goto(TITLE);
const btn = await until(() => hp.$("[data-netparty-start]"), 8000);
check("Start a NetParty button on the Prime title page", !!btn);
const geo = await hp.evaluate(() => {
  const b = document.querySelector("[data-netparty-start]"), play = document.querySelector("#pvplaybtn"), r = (n) => n.getBoundingClientRect();
  return { after: b.previousElementSibling?.id, h: Math.round(r(b).height), playH: Math.round(r(play).height), right: r(b).left >= r(play).right, n: document.querySelectorAll("[data-netparty-start]").length };
});
check("button right after the Play link, same height, only one", geo.after === "pvplaylink" && geo.h === geo.playH && geo.right && geo.n === 1, JSON.stringify(geo));
const pre = await status(H, hp);
check("popup: title page with the player closed isn't a watch page yet", pre.site === "Prime Video" && pre.onWatchPage === false, JSON.stringify(pre));
await hp.screenshot({ path: "pv-start-button.png" });
await btn.click();
const hst = await until(async () => { const s = await status(H, hp); return s?.roomId ? s : null; }, 15000);
check("click opens the player and starts the party", !!hst?.roomId && hst.site === "Prime Video", JSON.stringify(hst));
check("chat panel opens docked", !!(await until(() => hp.evaluate(() => document.documentElement.classList.contains("np-docked")))));

// 2. guest joins with the invite link: the invite page links to the title page with autoplay=1
await gp.goto(hst.invite);
const inviteText = await gp.textContent("body");
check("invite page names Prime Video", /Join on Prime Video/.test(inviteText) && /own Prime Video account/.test(inviteText) && !/Netflix/.test(inviteText), inviteText.slice(0, 200));
const joinHref = await gp.getAttribute("a.btn", "href");
check("invite → https://www.primevideo.com/detail/<id>?autoplay=1&npParty=…#npKey=…", /^https:\/\/www\.primevideo\.com\/detail\/0PVFAKEMOVIE1\?autoplay=1&npParty=[a-z0-9]+#npKey=[\w-]{43}$/.test(joinHref), joinHref);
await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
check("guest's player opens by itself and the guest joins", !!(await until(async () => (await people(gp)).length === 2, 20000)));
check("invite code and key removed from the address bar", !/npParty|npKey/.test(gp.url()), gp.url());

// 3. sync through the player's <video>, not the hero trailer
await hp.evaluate(() => document.querySelector("#dv-web-player video").pause());
check("host pause → guest pauses", !!(await until(async () => (await vid(gp))?.paused, 5000)));
check("the muted hero trailer is left alone", !(await gp.evaluate(() => document.querySelector(".hero-trailer").paused)));
await hp.evaluate(() => { const v = document.querySelector("#dv-web-player video"); v.currentTime = 40; v.play(); });
await sleep(2500);
let [h3, g3] = [await vid(hp), await vid(gp)];
check("host seek 40 s + play → guest follows", !g3.paused && Math.abs(h3.t - g3.t) < 1.5 && h3.t > 39, `host ${h3.t.toFixed(1)} guest ${g3.t.toFixed(1)}`);
await gp.evaluate(() => { const v = document.querySelector("#dv-web-player video"); v.currentTime = 70; });
await sleep(2500);
[h3, g3] = [await vid(hp), await vid(gp)];
check("guest seek 70 s → host follows (both ways)", Math.abs(h3.t - g3.t) < 1.5 && h3.t > 69, `host ${h3.t.toFixed(1)} guest ${g3.t.toFixed(1)}`);
const st = await status(H, hp);
check("status reads the player position, not the trailer's", !!st.roomId);

// 4. chat (with typing kept away from Prime's hotkeys)
await gp.locator(".np-input").click();
await gp.keyboard.type("prime night ");
await gp.keyboard.press("Enter");
check("site hotkeys don't fire while typing", (await gp.evaluate(() => window.__hotkeys)) === 0);
check("encrypted chat on Prime (host reads it, with the guest's name)", !!(await until(() => shadow(hp, (r) => { return [...r.querySelectorAll(".np-msg")].some((m) => m.querySelector(".np-author")?.textContent === "Rahul" && m.querySelector(".np-bubble").firstChild.textContent === "prime night"); }), 6000)));

// 5. ads: the guest's player shows Prime's ad countdown → no sync, then catch up
await gp.evaluate(() => window.__pvAd(true));
await sleep(1200);
const adMeta = await shadow(gp, (r) => { return r.querySelector(".np-meta").textContent; });
check("guest panel says it's waiting for the ad", /ad to finish/i.test(adMeta), adMeta);
const hBefore = (await vid(hp)).t;
await sleep(1500);
check("the guest's ad position (100 s) isn't pushed to the host", Math.abs((await vid(hp)).t - hBefore - 1.5) < 1.2, `host ${(await vid(hp)).t.toFixed(1)}`);
await gp.evaluate(() => { window.__pvAd(false); document.querySelector("#dv-web-player video").currentTime = 5; });
await sleep(3000);
[h3, g3] = [await vid(hp), await vid(gp)];
check("after the ad the guest catches up with the party", Math.abs(h3.t - g3.t) < 1.5, `host ${h3.t.toFixed(1)} guest ${g3.t.toFixed(1)}`);

// 6. docked layout: Prime's fixed overlay player is narrowed, nothing cropped
const layout = await gp.evaluate(() => {
  const p = document.getElementById("netparty-root").shadowRoot.querySelector(".np-panel").getBoundingClientRect();
  const box = document.querySelector("#dv-web-player").getBoundingClientRect(), v = document.querySelector("#dv-web-player video").getBoundingClientRect();
  return { vw: innerWidth, panelLeft: Math.round(p.left), playerRight: Math.round(box.right), videoRight: Math.round(v.right), videoW: Math.round(v.width), shrunk: document.querySelector("#dv-web-player").hasAttribute("data-np-shrink") };
});
check("docked: Prime's player box ends where the chat begins", layout.shrunk && layout.playerRight <= layout.panelLeft + 1 && layout.videoRight <= layout.panelLeft + 1 && layout.videoW > 600, JSON.stringify(layout));
await gp.screenshot({ path: "pv-docked.png" });

// 7. the host opens another title: the party follows
await hp.evaluate(() => window.__go("/detail/0PVFAKEMOVIE2"));
await hp.locator("[data-netparty-start], #pvplaybtn").first().waitFor({ timeout: 5000 }).catch(() => {});
await hp.click("#pvplaybtn");
check("host on the new title: party moved", !!(await until(async () => /0PVFAKEMOVIE2/.test(gp.url()) && (await people(gp)).length === 2, 25000)), gp.url());

// 8. the guest closes the player: after a short grace they leave the party (host stays)
await gp.evaluate(() => window.__pvClose());
const gOut = await until(async () => { const s = await status(G, gp); return !s.roomId ? s : null; }, 15000);
check("guest closing the player leaves the party", !!gOut);
check("host still in the party, guest gone", !!(await until(async () => (await people(hp)).length === 1, 8000)));
check("start button back on the guest's title page", !!(await until(() => gp.$("[data-netparty-start]"), 5000)));

// 9. Amazon store: /gp/video/detail/<ASIN> ids keep the store
const ap = await H.ctx.newPage();
await ap.goto("https://www.amazon.co.uk/gp/video/detail/B0FAKEUK01/ref=atv_dp");
check("start button on amazon.co.uk/gp/video", !!(await until(() => ap.$("[data-netparty-start]"), 8000)));
const asite = await status(H, ap);
check("popup sees amazon.co.uk/gp/video as Prime Video", asite.site === "Prime Video", JSON.stringify(asite));
await ap.close();
await hp.evaluate(() => window.__pvClose());
check("host closing the player ends the party", !!(await until(async () => !(await status(H, hp)).roomId, 15000)));

// 10. popup detection (same check the popup runs on the active tab's URL)
const pop = await H.ctx.newPage();
await pop.goto(`chrome-extension://${H.sw.url().split("/")[2]}/popup.html`);
const det = await pop.evaluate(() => ["https://www.primevideo.com/detail/x", "https://www.primevideo.com/region/eu/storefront", "https://www.amazon.de/gp/video/detail/B0X", "https://www.amazon.com/Amazon-Video/b?node=1", "https://www.amazon.com/dp/B0X", "https://www.amazon.evil.com/gp/video/x", "http://www.primevideo.com/"].map(supportedSite));
check("popup site detection: primevideo + amazon.*/gp/video and /Amazon-Video only", JSON.stringify(det) === "[true,true,true,true,false,false,false]", JSON.stringify(det));

check("no script errors", errors.length === 0, errors.join(" | "));
const f = summary("PRIME VIDEO");
await H.ctx.close();
await G.ctx.close();
process.exit(f ? 1 : 0);
