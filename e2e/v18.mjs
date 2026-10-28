// 1.8 features e2e (fake Netflix, two real Chromium profiles with fake camera + mic):
//   - your own messages show your picture and name, like everyone else's (and follow changes)
//   - light / dark theme: follows prefers-color-scheme by default, Theme setting in the popup overrides it,
//     persisted; a WCAG contrast audit of every visible text in the panel, pickers, voice bar, camera
//     strip, toast and popup, in both themes
//   - video chat over the voice mesh: camera tiles both ways with live frames, 640x360 / ≤24 fps cap,
//     camera off removes the tile, leaving voice stops the camera, SDP stays encrypted (leak audit),
//     camera permission denied → clear message
//   - 1.9 camera view: docked in the chat panel by default (16:9 tiles fill most of it, chat keeps
//     ≥ 4 lines, compact chrome, no overflow at 1280–1920, 1/2/3 cameras), the panel closed → floating,
//     pop out (bigger floating window), collapse, drag anywhere incl. over the chat, resize (mouse and
//     keyboard), dock back, fullscreen, remembered across a reload, clicks never reach the player
//   - "Your profile": name field (from your tile or your avatar), Enter / blur save, empty ignored,
//     Esc cancels, 24-char cap, the other peer sees the new name
//   - HiDPI (deviceScaleFactor 2 and 3): no raster image drawn below 2x/3x, avatars are font glyphs
import { launch, shadow, until, people, check, summary, out, sleep, tap, leaks, keyOf } from "./lib.mjs";
import { spawn } from "node:child_process";
const SITE = "https://www.netflix.com/watch/12345";
// a party server with GIFs on (mock KLIPY on :8444), behind the recording proxy
const srv = spawn(process.execPath, ["server.js"], {
  cwd: "/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/server",
  env: { ...process.env, PORT: "8796", KLIPY_KEY: "test-key", KLIPY_BASE: "http://127.0.0.1:8444" },
  stdio: "ignore",
});
await sleep(1200);
const T = tap(8793, 8796);

const H = await launch("/tmp/pw-8h", { name: "Chirag", avatar: "🦊", extra: { serverUrl: T.url }, ctxOpts: { deviceScaleFactor: 2 } });
const G = await launch("/tmp/pw-8g", { name: "Rahul", avatar: "🐼", extra: { serverUrl: T.url }, ctxOpts: { deviceScaleFactor: 3 } });
const hp = await H.ctx.newPage(), gp = await G.ctx.newPage();
const errors = [];
for (const [p, n] of [[hp, "host"], [gp, "guest"]]) {
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  p.on("console", (m) => {
    if (m.type() === "error" && !/Content Security Policy|ERR_|status of 40|GIF/.test(m.text())) errors.push(n + " console: " + m.text());
    if (process.env.DEBUG) out(n + " console:", m.text().slice(0, 200));
  });
}
await hp.emulateMedia({ colorScheme: "dark" });
await gp.emulateMedia({ colorScheme: "dark" });
await hp.goto(SITE);
await hp.waitForTimeout(2000);
const created = await H.sw.evaluate(async (url) => {
  const [t] = await chrome.tabs.query({ url: url + "*" });
  return chrome.tabs.sendMessage(t.id, { cmd: "create" });
}, SITE);
check("party created", !!created?.invite);
const KEY = keyOf(created.invite);
await gp.goto(created.invite);
await until(async () => !!(await gp.$("a.btn:not([hidden])")), 5000);
await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
check("guest joined", !!(await until(async () => (await people(gp)).length === 2, 20000)));

// ---------------------------------------------------------------- own messages: picture + name
await hp.locator(".np-input").click();
await hp.keyboard.type("my own line");
await hp.keyboard.press("Enter");
await gp.locator(".np-input").click();
await gp.keyboard.type("guest line");
await gp.keyboard.press("Enter");
const lines = (p) => shadow(p, (r) => { return [...r.querySelectorAll(".np-msg")].map((m) => ({ mine: m.classList.contains("np-mine"), pic: m.querySelector(".np-mav")?.textContent || null, name: m.querySelector(".np-author")?.textContent || null, text: m.querySelector(".np-bubble").firstChild.textContent })); });
const hl = await until(async () => { const l = await lines(hp); return l.length >= 2 && l; }, 6000);
const mineH = hl.find((l) => l.text === "my own line"), theirsH = hl.find((l) => l.text === "guest line");
check("own message shows your picture and name", mineH?.mine && mineH.pic === "🦊" && mineH.name === "Chirag", JSON.stringify(mineH));
check("other people's messages unchanged (picture + name)", !theirsH?.mine && theirsH.pic === "🐼" && theirsH.name === "Rahul", JSON.stringify(theirsH));
const gl = await lines(gp);
check("guest: own line has 🐼 Rahul, host's line 🦊 Chirag", JSON.stringify(gl.filter((l) => l.text === "guest line" || l.text === "my own line").map((l) => [l.mine, l.pic, l.name])) === JSON.stringify([[false, "🦊", "Chirag"], [true, "🐼", "Rahul"]]), JSON.stringify(gl));
const geo = await shadow(hp, (r) => { const m = [...r.querySelectorAll(".np-msg.np-mine")].pop(), av = m.querySelector(".np-mav").getBoundingClientRect(), b = m.querySelector(".np-bubble").getBoundingClientRect(), p = r.querySelector(".np-chat").getBoundingClientRect(); return { avRight: av.left >= b.right - 1, nearEdge: p.right - av.right < 24, size: Math.round(av.width) }; });
check("own picture sits on the right of your bubble", geo.avRight && geo.nearEdge && geo.size === 26, JSON.stringify(geo));
await H.sw.evaluate(() => chrome.storage.sync.set({ name: "Chirag R", avatar: "🍕" }));
check("own line follows your name + picture change", !!(await until(async () => { const l = (await lines(hp)).find((x) => x.text === "my own line"); return l?.name === "Chirag R" && l.pic === "🍕"; }, 5000)));
check("the guest sees the change on that line too", !!(await until(async () => { const l = (await lines(gp)).find((x) => x.text === "my own line"); return l?.name === "Chirag R" && l.pic === "🍕"; }, 5000)));
await sleep(300);
await hp.locator(".np-input").click();
await hp.keyboard.type("after rename");
await hp.keyboard.press("Enter");
check("new own line uses the new name", !!(await until(async () => (await lines(hp)).some((x) => x.text === "after rename" && x.mine && x.name === "Chirag R" && x.pic === "🍕"), 5000)));

// ---------------------------------------------------------------- lines within a minute stack (no repeated name/picture)
for (const t of ["burst one", "burst two"]) {
  await hp.locator(".np-input").click();
  await hp.keyboard.type(t);
  await hp.keyboard.press("Enter");
  await sleep(150);
}
const shown = (p) => shadow(p, (r) => { return [...r.querySelectorAll(".np-msg")].map((m) => ({ text: m.querySelector(".np-bubble").firstChild.textContent, cont: m.classList.contains("np-cont"), nameShown: getComputedStyle(m.querySelector(".np-author")).display !== "none", picShown: getComputedStyle(m.querySelector(".np-mav")).visibility !== "hidden", h: Math.round(m.getBoundingClientRect().height) })); });
const pick = (l, ...t) => t.map((x) => l.find((y) => y.text === x));
const [ar, b1, b2] = pick(await until(async () => { const l = await shown(hp); return l.some((x) => x.text === "burst two") && l; }, 5000), "after rename", "burst one", "burst two");
check("first line of a burst keeps your name and picture", ar && !ar.cont && ar.nameShown && ar.picShown, JSON.stringify(ar));
check("lines sent within a minute stack: no repeated name or picture", b1?.cont && b2?.cont && !b1.nameShown && !b1.picShown && !b2.nameShown && !b2.picShown, JSON.stringify([b1, b2]));
check("stacked lines are shorter than the first (no name row)", b1.h < ar.h, JSON.stringify([ar.h, b1.h]));
const [gar, gb1, gb2] = pick(await until(async () => { const l = await shown(gp); return l.some((x) => x.text === "burst two") && l; }, 5000), "after rename", "burst one", "burst two");
check("the guest sees the same stacking", gar && !gar.cont && gar.nameShown && gb1?.cont && gb2?.cont && !gb1.nameShown && !gb2.picShown, JSON.stringify([gar, gb1, gb2]));
await gp.locator(".np-input").click();
await gp.keyboard.type("guest cuts in");
await gp.keyboard.press("Enter");
await sleep(300);
await hp.locator(".np-input").click();
await hp.keyboard.type("after the guest");
await hp.keyboard.press("Enter");
const [gCut, ag] = pick(await until(async () => { const l = await shown(hp); return l.some((x) => x.text === "after the guest") && l; }, 5000), "guest cuts in", "after the guest");
check("someone else's line breaks the stack: both show name and picture again", gCut && !gCut.cont && gCut.nameShown && ag && !ag.cont && ag.nameShown && ag.picShown, JSON.stringify([gCut, ag]));

// ---------------------------------------------------------------- theme
const panelBg = (p) => shadow(p, (r) => { return getComputedStyle(r.querySelector(".np-panel")).backgroundColor; });
const DARK = "rgb(20, 20, 24)", LIGHT = "rgb(255, 255, 255)";
check("System + dark OS: dark panel", (await panelBg(hp)) === DARK, await panelBg(hp));
await hp.emulateMedia({ colorScheme: "light" });
check("System + light OS: light panel (follows prefers-color-scheme live)", (await panelBg(hp)) === LIGHT, await panelBg(hp));
await H.sw.evaluate(() => chrome.storage.sync.set({ theme: "dark" }));
check("Theme = Dark overrides a light OS", !!(await until(async () => (await panelBg(hp)) === DARK, 3000)));
await hp.emulateMedia({ colorScheme: "dark" });
await H.sw.evaluate(() => chrome.storage.sync.set({ theme: "light" }));
check("Theme = Light overrides a dark OS", !!(await until(async () => (await panelBg(hp)) === LIGHT, 3000)));
// popup: the setting, persisted
const extId = H.sw.url().split("/")[2];
const pop = await H.ctx.newPage();
await pop.emulateMedia({ colorScheme: "dark" });
await pop.setViewportSize({ width: 320, height: 640 });
await pop.goto(`chrome-extension://${extId}/popup.html`);
await pop.evaluate(() => (document.getElementById("prefs").open = true));
const popState = () => pop.evaluate(() => ({ checked: [...document.querySelectorAll("[data-theme-opt]")].find((b) => b.getAttribute("aria-checked") === "true")?.dataset.themeOpt, bg: getComputedStyle(document.body).backgroundColor, attr: document.documentElement.dataset.theme || null }));
check("popup shows the saved Theme (Light) and is light", JSON.stringify(await popState()) === JSON.stringify({ checked: "light", bg: LIGHT, attr: "light" }), JSON.stringify(await popState()));
await pop.click('[data-theme-opt="system"]');
check("popup: System → follows the OS (dark here), setting cleared", JSON.stringify(await popState()) === JSON.stringify({ checked: "system", bg: "rgb(18, 18, 22)", attr: null }) && !("theme" in (await H.sw.evaluate(() => chrome.storage.sync.get("theme")))), JSON.stringify(await popState()));
check("…and the open panel follows (dark OS)", !!(await until(async () => (await panelBg(hp)) === DARK, 3000)));
await pop.click('[data-theme-opt="light"]');
await pop.reload();
await pop.evaluate(() => (document.getElementById("prefs").open = true));
check("Theme persists across popup reopen", (await popState()).checked === "light");

// WCAG contrast of every visible text node's element, against its effective background
// (opacity and translucent backgrounds blended down to the panel / page)
const audit = (p, label) =>
  shadow(p, (r) => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
    const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
    const bgOf = (n) => {
      const stack = [];
      for (let x = n; x && x.nodeType === 1; x = x.parentElement || x.getRootNode().host) {
        const cs = getComputedStyle(x);
        const c = parse(cs.backgroundColor);
        if (cs.backgroundImage.includes("gradient")) stack.push({ r: 124, g: 92, b: 255, a: 1 }); // brand gradient, darkest end
        else if (c && c.a > 0) stack.push(c);
        if (stack.length && stack[stack.length - 1].a === 1) break;
      }
      let bg = { r: 0, g: 0, b: 0, a: 1 }; // the video
      for (const c of stack.reverse()) bg = over(c, bg);
      return bg;
    };
    const opac = (n) => { let o = 1; for (let x = n; x && x.nodeType === 1; x = x.parentElement || x.getRootNode().host) o *= parseFloat(getComputedStyle(x).opacity); return o; };
    const bad = [];
    let n = 0;
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const e = t.parentElement;
      if (!t.textContent.trim() || !e || e.closest(".np-emo, .np-fly, [hidden], .np-tool-gif.np-disabled, .np-cam-pic")) continue;
      const rect = e.getBoundingClientRect();
      if (!rect.width || !rect.height || !e.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const cs = getComputedStyle(e);
      if (e.matches(":disabled") || e.closest("button:disabled")) continue; // disabled controls are exempt (WCAG 1.4.3)
      const bg = bgOf(e);
      const fg = over({ ...parse(cs.color), a: parse(cs.color).a * opac(e) }, bg);
      const [L1, L2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (L1 + 0.05) / (L2 + 0.05);
      const px = parseFloat(cs.fontSize), large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight) >= 700);
      n++;
      if (ratio < (large ? 3 : 4.5)) bad.push(`${(e.className || e.tagName).toString().slice(0, 30)} "${t.textContent.trim().slice(0, 18)}" ${ratio.toFixed(2)}`);
    }
    return { n, bad };
  }).then((x) => ({ label, ...x }));
const surfaces = async (p) => {
  const res = [];
  res.push(await audit(p, "panel + chat + voice"));
  await p.locator('.np-tool[aria-label="Emoji"]').click();
  res.push(await audit(p, "emoji picker"));
  await p.keyboard.press("Escape");
  await p.locator('.np-tool[aria-label="Reactions"]').click();
  await p.locator(".np-react-edit").click();
  res.push(await audit(p, "reactions tray (editing)"));
  await p.locator(".np-react-edit").click();
  await p.mouse.click(300, 300);
  await p.locator('.np-tool[aria-label="GIFs"]').click();
  await until(() => shadow(p, (r) => { return r.querySelectorAll(".np-gif-thumb").length >= 4; }), 5000);
  res.push(await audit(p, "GIF picker (results, chips, attribution)"));
  await p.keyboard.press("Escape");
  await p.locator(".np-person.np-me").click();
  res.push(await audit(p, "profile popover"));
  await p.keyboard.press("Escape");
  return res;
};

// ---------------------------------------------------------------- video chat
await shadow(gp, (r) => { r.querySelector(".np-join-voice").click(); });
await sleep(500);
await shadow(hp, (r) => { r.querySelector(".np-join-voice").click(); });
const linked = (p) => shadow(p, (r) => { return [...r.querySelectorAll(".np-person[data-link]")].map((n) => n.dataset.link).join(); });
check("voice connects", !!(await until(async () => (await linked(hp)) === "connected" && (await linked(gp)) === "connected", 20000)));
const camBtn = (p) => p.locator(".np-cam-btn");
check("camera button in the voice bar, off", (await camBtn(gp).getAttribute("aria-pressed")) === "false" && (await camBtn(gp).getAttribute("aria-label")) === "Turn camera on");
check("no camera view while nobody's camera is on (normal panel layout)", await shadow(hp, (r) => { return r.querySelector(".np-cams").hidden && !r.querySelector(".np-panel").classList.contains("np-camdock") && getComputedStyle(r.querySelector(".np-section-label")).display !== "none"; }));
await camBtn(gp).click();
const tiles = (p) => shadow(p, (r) => { const c = r.querySelector(".np-cams"); return c.hidden ? [] : [...c.querySelectorAll(".np-cam")].map((t) => { const v = t.querySelector("video"); return { name: t.querySelector(".np-cam-name").textContent, w: v.videoWidth, h: v.videoHeight, t: v.currentTime, live: !t.classList.contains("np-cam-wait"), self: v.classList.contains("np-self") }; }); });
const frames = async (p, name) => { const a = (await tiles(p)).find((x) => x.name === name); await sleep(1000); const b = (await tiles(p)).find((x) => x.name === name); return a && b && b.t > a.t && b.w > 0 ? b : null; };
const gSelf = await until(async () => (await tiles(gp)).find((x) => x.self && x.w > 0), 6000);
check("guest sees their own mirrored preview", !!gSelf && gSelf.name === "You", JSON.stringify(await tiles(gp)));
const settings = await shadow(gp, (r) => { const s = r.querySelector(".np-cam video.np-self").srcObject.getVideoTracks()[0].getSettings(); return { w: s.width, h: s.height, fps: s.frameRate }; });
check("camera capped at 640x360, ≤24 fps", settings.w <= 640 && settings.h <= 360 && settings.fps <= 24 && settings.w > 0, JSON.stringify(settings));
const hT = await until(() => frames(hp, "Rahul"), 15000, 500);
check("host sees Rahul's camera tile with live frames", !!hT && hT.live, JSON.stringify(await tiles(hp)));
check("guest's tile on the host is the received size (≤640x360)", hT && hT.w <= 640 && hT.h <= 360, JSON.stringify(hT));

// ---- docked by default: the tiles live in the chat panel and fill most of it
// geometry of the camera view + panel (all in CSS px)
const geom = (p) => shadow(p, (r) => {
  const P = r.querySelector(".np-panel"), c = r.querySelector(".np-cams"), chat = r.querySelector(".np-chat"), inp = r.querySelector(".np-input");
  const pr = P.getBoundingClientRect(), cr = c.getBoundingClientRect(), ir = inp.getBoundingClientRect();
  const ts = [...c.querySelectorAll(".np-cam")].map((t) => { const b = t.getBoundingClientRect(); return { w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10, l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; });
  const kids = [...P.children].filter((n) => !n.classList.contains("np-pop") && n.getClientRects().length);
  const vb = r.querySelector(".np-voice-bar");
  const visible = (sel) => { const n = r.querySelector(sel); return !!n && n.checkVisibility() && n.getBoundingClientRect().height > 0; };
  return {
    docked: P.contains(c) && c.classList.contains("np-cams-docked"), camdock: P.classList.contains("np-camdock"), floating: c.classList.contains("np-cams-float") && !P.contains(c),
    vw: innerWidth, vh: innerHeight, ph: Math.round(pr.height), pw: Math.round(pr.width), pl: Math.round(pr.left),
    cam: { l: Math.round(cr.left), t: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height) },
    share: Math.round((cr.height / pr.height) * 100) / 100, tiles: ts,
    chatH: chat.clientHeight, inputOk: ir.height >= 30 && ir.bottom <= pr.bottom && ir.right <= pr.right,
    overflow: P.scrollHeight > P.clientHeight + 1 || kids.some((n) => { const b = n.getBoundingClientRect(); return b.right > pr.right + 1 || b.left < pr.left - 1 || b.bottom > pr.bottom + 1; }) || (vb && vb.scrollWidth > vb.clientWidth + 1),
    watching: visible(".np-section-label"), copyPill: visible(".np-pill"), headActs: visible(".np-copy-icon") && visible(".np-leave-icon"), people: visible(".np-person.np-me"),
  };
});
const r169 = (t) => Math.abs(t.w / t.h - 16 / 9) < 0.03;
const inside = (g) => g.tiles.every((t) => t.l >= g.pl - 1 && t.r <= g.pl + g.pw + 1 && t.t >= 0 && t.b <= g.vh + 1);
const lines4 = (g) => g.chatH >= 4 * 14 * 1.4 + 16; // ≥ 4 lines of 14 px chat text (+ padding)
const g1 = await geom(hp);
check("1 camera: docked in the chat panel by default (compact panel chrome)", g1.docked && g1.camdock && !g1.floating && !g1.watching && !g1.copyPill && g1.headActs && g1.people, JSON.stringify(g1));
check("1 camera: one big 16:9 tile across the panel width", g1.tiles.length === 1 && r169(g1.tiles[0]) && g1.tiles[0].w >= g1.pw * 0.9 && inside(g1), JSON.stringify(g1.tiles));
check("1 camera: chat keeps ≥ 4 lines + the composer, nothing overflows", lines4(g1) && g1.inputOk && !g1.overflow, JSON.stringify(g1));
check("docked default is remembered as docked", await hp.evaluate(() => (JSON.parse(sessionStorage.getItem("netpartyCams") || "{}").mode || "dock") === "dock"));
await hp.screenshot({ path: "v19-docked-1cam.png" });
out("geometry 1 cam 1280x720:", JSON.stringify({ share: g1.share, tile: g1.tiles[0], chatH: g1.chatH, ph: g1.ph, pw: g1.pw }));

await camBtn(hp).click();
const gT = await until(() => frames(gp, "Chirag R"), 15000, 500);
check("both cameras on: guest sees the host's live video", !!gT && gT.live, JSON.stringify(await tiles(gp)));
check("guest view has 2 tiles (you first), count label", JSON.stringify((await tiles(gp)).map((t) => t.name)) === '["You","Chirag R"]' && (await shadow(gp, (r) => { return r.querySelector(".np-cams-count").textContent; })) === "2 cameras");
await until(async () => (await geom(hp)).tiles.length === 2, 5000);
await sleep(300);
const g2 = await geom(hp);
check("2 cameras: 16:9 tiles inside the panel, they fill most of it", g2.docked && g2.tiles.length === 2 && g2.tiles.every(r169) && inside(g2) && g2.share >= 0.45 && g2.share <= 0.66, JSON.stringify(g2));
check("2 cameras: chat keeps ≥ 4 lines + the composer, nothing overflows", lines4(g2) && g2.inputOk && !g2.overflow, JSON.stringify(g2));
out("geometry 2 cams 1280x720:", JSON.stringify({ share: g2.share, tiles: g2.tiles.map((t) => [t.w, t.h]), chatH: g2.chatH, ph: g2.ph }));
await hp.screenshot({ path: "v19-docked-2cams.png" });
await gp.screenshot({ path: "v19-docked-2cams-guest.png" });
// widths 1280 → 1920, both themes: the panel never overflows
for (const [w, h] of [[1440, 900], [1920, 1080], [1280, 720]]) {
  await hp.setViewportSize({ width: w, height: h });
  await sleep(500);
  const g = await geom(hp);
  check(`${w}x${h}: 2 docked cameras fill the panel, 16:9, chat ≥ 4 lines, no overflow`, g.docked && g.tiles.length === 2 && g.tiles.every(r169) && inside(g) && g.share >= 0.4 && g.share <= 0.66 && lines4(g) && g.inputOk && !g.overflow, JSON.stringify({ share: g.share, pw: g.pw, ph: g.ph, tiles: g.tiles, chatH: g.chatH, overflow: g.overflow }));
  out(`geometry 2 cams ${w}x${h}:`, JSON.stringify({ share: g.share, pw: g.pw, tiles: g.tiles.map((t) => [t.w, t.h]), chatH: g.chatH }));
}
check("guest (dark) docked view: no overflow either", !(await geom(gp)).overflow && (await geom(gp)).docked);

// a third camera (another browser): 3 tiles, still 16:9 and inside the panel
const D = await launch("/tmp/pw-8d", { name: "Meera", avatar: "🦄", extra: { serverUrl: T.url } });
const dp = await D.ctx.newPage();
await dp.goto(created.invite);
await until(async () => !!(await dp.$("a.btn:not([hidden])")), 5000);
await Promise.all([dp.waitForNavigation(), dp.click("a.btn")]);
await until(async () => (await people(dp)).length === 3, 20000);
await shadow(dp, (r) => { r.querySelector(".np-join-voice").click(); });
await until(() => dp.locator(".np-cam-btn").isVisible(), 8000);
await dp.locator(".np-cam-btn").click();
const m3 = await until(() => frames(hp, "Meera"), 20000, 500);
check("3rd camera arrives live", !!m3, JSON.stringify(await tiles(hp)));
await sleep(300);
const g3 = await geom(hp);
check("3 cameras docked: 16:9 tiles inside the panel, ≥ half of it, chat ≥ 4 lines, no overflow", g3.tiles.length === 3 && g3.tiles.every(r169) && inside(g3) && g3.share >= 0.45 && g3.share <= 0.66 && lines4(g3) && !g3.overflow, JSON.stringify(g3));
out("geometry 3 cams 1280x720:", JSON.stringify({ share: g3.share, tiles: g3.tiles.map((t) => [t.w, t.h]), chatH: g3.chatH }));
await hp.screenshot({ path: "v19-docked-3cams.png" });
await D.ctx.close();
check("3rd person gone: back to 2 tiles", !!(await until(async () => (await tiles(hp)).length === 2, 15000)), JSON.stringify(await tiles(hp)));

// contrast in both themes, with everything on screen (host: light; guest: dark via System)
await gp.emulateMedia({ colorScheme: "dark" });
const lightRes = await surfaces(hp);
const darkRes = await surfaces(gp);
for (const r of [...lightRes, ...darkRes.map((x) => ({ ...x, label: "dark " + x.label }))]) check(`contrast ≥ AA: ${r.label} (${r.n} texts)`, r.n > 0 && !r.bad.length, r.bad.join(" | "));

// ---- the chat panel closed while cameras are docked: they float in the window's place
await shadow(hp, (r) => { r.querySelector(".np-close").click(); });
await sleep(300);
const gc = await geom(hp);
const closedInfo = await shadow(hp, (r) => { const c = r.querySelector(".np-cams"), m = r.querySelector(".np-cams-mode"); const b = c.getBoundingClientRect(); return { vis: c.checkVisibility() && b.width > 300 && b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight, label: m.getAttribute("aria-label"), panel: r.querySelector(".np-panel").checkVisibility() }; });
check("chat closed: cameras float over the video (still visible), dock button offers to open the chat", gc.floating && !gc.camdock && closedInfo.vis && !closedInfo.panel && /opens the chat/.test(closedInfo.label), JSON.stringify([gc.cam, closedInfo]));
check("…and the docked choice is kept (not switched to popped out)", await hp.evaluate(() => (JSON.parse(sessionStorage.getItem("netpartyCams") || "{}").mode || "dock") === "dock"));
await gp.locator(".np-input").click();
await gp.keyboard.type("toast in light mode");
await gp.keyboard.press("Enter");
await sleep(600);
const toastRes = await audit(hp, "toast + floating cameras (light)");
check(`contrast ≥ AA: ${toastRes.label} (${toastRes.n} texts)`, toastRes.n >= 3 && !toastRes.bad.length, toastRes.bad.join(" | "));
await hp.screenshot({ path: "v18-light-closed.png" });
await shadow(hp, (r) => { r.querySelector(".np-toggle").click(); });
await sleep(300);
check("chat reopened: cameras dock back into it", (await geom(hp)).docked);
// the dock button in the closed state opens the chat with the cameras docked
await shadow(hp, (r) => { r.querySelector(".np-close").click(); });
await sleep(200);
await hp.locator(".np-cams-mode").click();
await sleep(300);
check("closed chat: the floating window's dock button opens the chat, cameras docked", await shadow(hp, (r) => { return r.querySelector(".np-root").classList.contains("np-open"); }) && (await geom(hp)).docked);

// popup in both themes
for (const th of ["light", "dark"]) {
  await pop.click(`[data-theme-opt="${th}"]`);
  const a = await pop.evaluate(() => {
    const parse = (c) => c.match(/[\d.]+/g).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map((x) => (x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const bgOf = (e) => { for (let x = e; x; x = x.parentElement) { const c = parse(getComputedStyle(x).backgroundColor); if (c.length < 4 || c[3] > 0) return c; } return [255, 255, 255]; };
    const bad = []; let n = 0;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      const e = t.parentElement;
      if (!t.textContent.trim() || e.closest(".emo, .hidden, script") || !e.getClientRects().length || e.closest("button:disabled")) continue;
      const [a, b] = [lum(parse(getComputedStyle(e).color)), lum(bgOf(e))].sort((x, y) => y - x);
      n++;
      if ((a + 0.05) / (b + 0.05) < 4.5) bad.push(`${e.tagName}.${e.className} "${t.textContent.trim().slice(0, 16)}" ${((a + 0.05) / (b + 0.05)).toFixed(2)}`);
    }
    return { n, bad };
  });
  check(`popup contrast ≥ AA (${th}, ${a.n} texts)`, a.n > 5 && !a.bad.length, a.bad.join(" | "));
  await pop.screenshot({ path: `v18-popup-${th}.png`, fullPage: true });
}

await hp.bringToFront(); // the popup tab was in front
// ---- pop out: a bigger floating window, normal panel layout comes back
const modeLabel = () => hp.locator(".np-cams-mode").getAttribute("aria-label");
check("docked view has a labelled pop-out button", (await modeLabel()) === "Pop out cameras");
await hp.locator(".np-cams-mode").click();
await sleep(400);
const gp1 = await geom(hp);
check("pop out: floating window over the page, bigger than the old strip, 16:9 tiles", gp1.floating && !gp1.docked && gp1.cam.w >= 400 && gp1.tiles.length === 2 && gp1.tiles.every(r169) && gp1.tiles.every((t) => t.w > 160), JSON.stringify(gp1));
check("pop out: the panel gets its normal layout back (WATCHING row, Copy invite)", !gp1.camdock && gp1.watching && gp1.copyPill && !gp1.headActs, JSON.stringify(gp1));
check("pop out remembered for the tab", await hp.evaluate(() => JSON.parse(sessionStorage.getItem("netpartyCams") || "{}").mode === "float"));
check("floating window has a labelled dock-back button, a move handle and a resize handle", (await modeLabel()) === "Dock cameras in the chat" && (await hp.locator(".np-cams-move").isVisible()) && (await hp.locator(".np-cams-grip").isVisible()));
await hp.screenshot({ path: "v19-popped.png" });
const floatRes = await audit(hp, "floating camera window (light)");
check(`contrast ≥ AA: ${floatRes.label} (${floatRes.n} texts)`, floatRes.n >= 3 && !floatRes.bad.length, floatRes.bad.join(" | "));

// collapse
await hp.locator(".np-cams-collapse").click();
const col = await shadow(hp, (r) => { const c = r.querySelector(".np-cams"); return { min: c.classList.contains("np-cams-min"), body: getComputedStyle(c.querySelector(".np-cams-body")).display, h: Math.round(c.getBoundingClientRect().height), exp: c.querySelector(".np-cams-collapse").getAttribute("aria-expanded") }; });
check("collapse hides the tiles, keeps the bar", col.min && col.body === "none" && col.h < 44 && col.exp === "false", JSON.stringify(col));
await hp.locator(".np-cams-collapse").click();
await sleep(200);
// drag anywhere by the bar, including over the chat
const bar = await shadow(hp, (r) => { const b = r.querySelector(".np-cams-count").getBoundingClientRect(), c = r.querySelector(".np-cams").getBoundingClientRect(); return { x: b.left + 20, y: b.top + 6, left: c.left, top: c.top }; });
const vBefore = await hp.evaluate(() => document.querySelector("video").paused);
await hp.mouse.move(bar.x, bar.y);
await hp.mouse.down();
await hp.mouse.move(bar.x + 200, bar.y - 150, { steps: 8 });
await hp.mouse.up();
const moved = await shadow(hp, (r) => { const c = r.querySelector(".np-cams").getBoundingClientRect(); return { x: Math.round(c.left), y: Math.round(c.top) }; });
check("drag moves the window with the pointer", Math.abs(moved.x - (bar.left + 200)) < 3 && Math.abs(moved.y - (bar.top - 150)) < 3, JSON.stringify([bar, moved]));
await hp.mouse.move(moved.x + 60, moved.y + 10);
await hp.mouse.down();
await hp.mouse.move(1270, 700, { steps: 8 });
await hp.mouse.up();
const clamped = await shadow(hp, (r) => { const c = r.querySelector(".np-cams").getBoundingClientRect(), p = r.querySelector(".np-panel").getBoundingClientRect(); return { right: Math.round(c.right), bottom: Math.round(c.bottom), left: Math.round(c.left), panelLeft: Math.round(p.left), vw: innerWidth, vh: innerHeight }; });
check("it can be dragged over the docked chat and still stays on screen", clamped.right > clamped.panelLeft && clamped.right <= clamped.vw && clamped.bottom <= clamped.vh, JSON.stringify(clamped));
const onTop = await shadow(hp, (r) => { const c = r.querySelector(".np-cams").getBoundingClientRect(); const hit = r.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2); return !!hit && !!hit.closest(".np-cams"); });
check("over the chat, the camera window draws above the chat panel", onTop);
await hp.screenshot({ path: "v18-cams-over-chat.png" });
check("dragging the window didn't pause/play the video", (await hp.evaluate(() => document.querySelector("video").paused)) === vBefore);
// back to the left, then resize from the corner (tiles stay 16:9)
await shadow(hp, (r) => { const b = r.querySelector(".np-cams-count").getBoundingClientRect(); return b; }).then(async (b) => { await hp.mouse.move(b.left + 20, b.top + 6); await hp.mouse.down(); await hp.mouse.move(60, 60, { steps: 8 }); await hp.mouse.up(); });
const before = await geom(hp);
const gr = await shadow(hp, (r) => { const b = r.querySelector(".np-cams-grip").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
await hp.mouse.move(gr.x, gr.y);
await hp.mouse.down();
await hp.mouse.move(gr.x + 140, gr.y + 20, { steps: 8 });
await hp.mouse.up();
const after = await geom(hp);
check("resize from the corner: wider window, tiles grow and stay 16:9", after.cam.w - before.cam.w > 120 && after.cam.w - before.cam.w < 160 && after.tiles.every(r169) && after.tiles[0].w > before.tiles[0].w, JSON.stringify([before.cam, after.cam, after.tiles]));
await hp.mouse.move(gr.x + 140, gr.y + 20);
await hp.mouse.down();
await hp.mouse.move(gr.x + 2000, gr.y + 2000, { steps: 6 });
await hp.mouse.up();
const huge = await geom(hp);
check("resize is capped to the screen", huge.cam.l + huge.cam.w <= huge.vw && huge.cam.t + huge.cam.h <= huge.vh && huge.tiles.every(r169), JSON.stringify(huge.cam));
// keyboard: arrow keys on the resize and move handles
await hp.locator(".np-cams-grip").focus();
const k0 = (await geom(hp)).cam;
await hp.keyboard.press("ArrowLeft");
await hp.keyboard.press("ArrowLeft");
const k1 = (await geom(hp)).cam;
check("keyboard: ←← on the resize handle makes it 48 px narrower", Math.abs(k0.w - k1.w - 48) <= 2, JSON.stringify([k0, k1]));
await hp.locator(".np-cams-move").focus();
await hp.keyboard.press("ArrowDown");
await hp.keyboard.press("ArrowRight");
const k2 = (await geom(hp)).cam;
check("keyboard: ↓→ on the move handle moves it 24 px each way", Math.abs(k2.l - k1.l - 24) <= 1 && Math.abs(k2.t - k1.t - 24) <= 1, JSON.stringify([k1, k2]));
// resize from any edge or corner: the opposite side stays put
const edgeAt = (dir) => shadow(hp, (r, a) => { const b = r.querySelector(".np-cams-edge-" + a).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, cur: getComputedStyle(r.querySelector(".np-cams-edge-" + a)).cursor }; }, dir);
const dragEdge = async (dir, dx, dy) => { const e = await edgeAt(dir); await hp.mouse.move(e.x, e.y); await hp.mouse.down(); await hp.mouse.move(e.x + dx, e.y + dy, { steps: 8 }); await hp.mouse.up(); return e; };
// park it mid-screen first so every edge has room
await hp.locator(".np-cams-move").focus();
for (let i = 0; i < 6; i++) await hp.keyboard.press("Shift+ArrowRight");
for (let i = 0; i < 2; i++) await hp.keyboard.press("Shift+ArrowDown");
const e0 = await geom(hp);
const ew = await dragEdge("w", -100, 0);
const e1 = await geom(hp);
check("left edge: drag out to widen, the right side stays put, tiles stay 16:9", ew.cur === "ew-resize" && e1.cam.w - e0.cam.w > 80 && Math.abs(e1.cam.l + e1.cam.w - (e0.cam.l + e0.cam.w)) <= 2 && e1.tiles.every(r169), JSON.stringify([e0.cam, e1.cam]));
const en = await dragEdge("n", 0, 40);
const e2 = await geom(hp);
check("top edge: drag down to shrink, the bottom stays put", en.cur === "ns-resize" && e2.cam.w < e1.cam.w - 40 && Math.abs(e2.cam.t + e2.cam.h - (e1.cam.t + e1.cam.h)) <= 2 && e2.tiles.every(r169), JSON.stringify([e1.cam, e2.cam]));
const enw = await dragEdge("nw", -80, -45);
const e3 = await geom(hp);
check("top-left corner: grows up and left, the bottom-right corner stays put", enw.cur === "nwse-resize" && e3.cam.w > e2.cam.w + 50 && Math.abs(e3.cam.l + e3.cam.w - (e2.cam.l + e2.cam.w)) <= 2 && Math.abs(e3.cam.t + e3.cam.h - (e2.cam.t + e2.cam.h)) <= 2, JSON.stringify([e2.cam, e3.cam]));
const ee = await dragEdge("e", 60, 0);
const e4 = await geom(hp);
check("right edge and bottom-right corner resize too", ee.cur === "ew-resize" && e4.cam.w > e3.cam.w + 40 && Math.abs(e4.cam.l - e3.cam.l) <= 2, JSON.stringify([e3.cam, e4.cam]));
check("edge resizes are remembered", await hp.evaluate(() => JSON.parse(sessionStorage.getItem("netpartyCams") || "{}").w) === Math.round(e4.cam.w) || Math.abs(await hp.evaluate(() => JSON.parse(sessionStorage.getItem("netpartyCams") || "{}").w) - e4.cam.w) <= 1);
check("resizing didn't pause/play the video", (await hp.evaluate(() => document.querySelector("video").paused)) === vBefore);
await hp.screenshot({ path: "v19-resized.png" });
check("arrow keys never reached the site's hotkeys", (await hp.evaluate(() => document.querySelector("video").paused)) === vBefore);
const kfocus = await shadow(hp, (r) => { const ae = r.activeElement; return ae && getComputedStyle(ae).outlineStyle !== "none" && ae.matches(":focus-visible"); });
check("keyboard focus is visible on the camera window controls", kfocus);
// clicks on tiles never reach the player (a site click-to-pause layer listening on the page)
const siteClicks = () => hp.evaluate(() => { window.__siteClicks = 0; const v = document.querySelector("video"); for (const t of ["click", "dblclick", "pointerdown", "mousedown"]) document.addEventListener(t, () => { window.__siteClicks++; if (t === "click") v.paused ? v.play() : v.pause(); }); });
await siteClicks();
const pausedA = await hp.evaluate(() => document.querySelector("video").paused);
const tc = await shadow(hp, (r) => { const b = r.querySelector(".np-cam:last-child").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 3 }; });
await hp.mouse.click(tc.x, tc.y);
await hp.mouse.dblclick(tc.x, tc.y);
await sleep(300);
check("clicks / double-clicks on a floating tile don't reach the page (video not paused)", (await hp.evaluate(() => window.__siteClicks)) === 0 && (await hp.evaluate(() => document.querySelector("video").paused)) === pausedA && !(await hp.evaluate(() => !!document.fullscreenElement)));

// remembered across a reload: popped out, same place and size
const keep = (await geom(hp)).cam;
await hp.reload();
await until(async () => (await people(hp)).length === 2, 20000);
const back = await until(async () => { const t = await tiles(hp); return t.some((x) => x.name === "Rahul" && x.live) && t; }, 25000, 500);
await sleep(600);
const gr2 = await geom(hp);
check("reload: voice rejoins, Rahul's camera comes back", !!back, JSON.stringify(back));
check("reload: still popped out, same place and size", gr2.floating && Math.abs(gr2.cam.l - keep.l) <= 1 && Math.abs(gr2.cam.t - keep.t) <= 1 && Math.abs(gr2.cam.w - keep.w) <= 1, JSON.stringify([keep, gr2.cam]));
// (the host's own camera is off after the reload; turn it back on)
await until(() => hp.locator(".np-cam-btn").isVisible(), 8000);
if ((await camBtn(hp).getAttribute("aria-pressed")) === "false") await camBtn(hp).click();
await until(async () => (await tiles(hp)).length === 2, 8000);

// fullscreen: floating window and docked view both work inside the fullscreen element
await hp.bringToFront();
await hp.click("#fsbtn");
await sleep(800);
const fs1 = await geom(hp);
const fsIn = await hp.evaluate(() => !!document.fullscreenElement?.contains(document.getElementById("netparty-root")));
const fsTop = await shadow(hp, (r) => { const c = r.querySelector(".np-cams").getBoundingClientRect(); const hit = r.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2); return !!hit?.closest(".np-cams"); });
check("fullscreen: floating camera window visible on top, inside the fullscreen element", fsIn && fs1.floating && fs1.tiles.length === 2 && fsTop, JSON.stringify(fs1.cam));
// keyboard: dock back with Enter on the focused button
await hp.locator(".np-cams-mode").focus();
await hp.keyboard.press("Enter");
await sleep(400);
const fs2 = await geom(hp);
check("fullscreen + keyboard: Enter on the dock button docks the cameras in the chat", fs2.docked && fs2.camdock && fs2.tiles.every(r169) && !fs2.overflow, JSON.stringify(fs2));
check("…focus stays on the (now pop-out) button", await shadow(hp, (r) => { const ae = r.activeElement; return !!ae && ae.classList.contains("np-cams-mode") && ae.getAttribute("aria-label") === "Pop out cameras"; }));
check("dock back remembered", await hp.evaluate(() => JSON.parse(sessionStorage.getItem("netpartyCams") || "{}").mode === "dock"));
await hp.keyboard.press(" ");
await sleep(400);
check("fullscreen + keyboard: Space pops them out again", (await geom(hp)).floating);
await hp.keyboard.press("Enter");
await sleep(300);
check("still fullscreen after all that (keys never reached the site)", await hp.evaluate(() => !!document.fullscreenElement) && (await geom(hp)).docked);
await hp.evaluate(() => document.exitFullscreen());
await sleep(600);
// clicks on a docked tile don't reach the player either (the page was reloaded: listen again)
await siteClicks();
const pausedB = await hp.evaluate(() => document.querySelector("video").paused);
const tc2 = await shadow(hp, (r) => { const b = r.querySelector(".np-cam:last-child").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 3 }; });
await hp.mouse.click(tc2.x, tc2.y);
await sleep(200);
check("clicks on a docked tile don't reach the page (video not paused)", (await hp.evaluate(() => window.__siteClicks)) === 0 && (await hp.evaluate(() => document.querySelector("video").paused)) === pausedB);

// ---- name editing from "Your profile" (your camera tile's name, the docked layout's way in)
const guestNames = () => shadow(gp, (r) => { return { people: [...r.querySelectorAll(".np-pname")].map((n) => n.textContent), tiles: [...r.querySelectorAll(".np-cam-name")].map((n) => n.textContent), authors: [...r.querySelectorAll(".np-author")].map((n) => n.textContent) }; });
const meTile = hp.locator(".np-cam-me");
check("your tile's name is a labelled button", (await meTile.getAttribute("aria-label")) === "Change your name and picture" && (await meTile.textContent()) === "You");
check("people-row button retitled", (await hp.locator(".np-person.np-me").getAttribute("aria-label")) === "Change your name and picture" && (await hp.locator(".np-person.np-me").getAttribute("title")) === "Change your name and picture");
await meTile.click();
const pv = await shadow(hp, (r) => { const p = r.querySelector(".np-avatar-pop"); const i = p.querySelector(".np-name-input"); const b = p.getBoundingClientRect(), P = r.querySelector(".np-panel").getBoundingClientRect(); return { open: p.classList.contains("np-pop-open"), title: p.querySelector(".np-pop-title").textContent, label: p.getAttribute("aria-label"), value: i.value, max: i.maxLength, inPanel: b.top >= P.top && b.bottom <= P.bottom + 1 }; });
check("tile name opens 'Your profile' with the name prefilled", pv.open && pv.title === "Your profile" && pv.label === "Your profile" && pv.value === "Chirag R" && pv.max === 24 && pv.inPanel, JSON.stringify(pv));
await hp.screenshot({ path: "v19-profile.png" });
const profRes = await audit(hp, "profile popover (light)");
check(`contrast ≥ AA: ${profRes.label} (${profRes.n} texts)`, profRes.n >= 3 && !profRes.bad.length, profRes.bad.join(" | "));
await hp.locator(".np-name-input").fill("Chirag NP");
await hp.keyboard.press("Enter");
check("Enter saves the name to chrome.storage.sync (like the popup)", !!(await until(async () => (await H.sw.evaluate(() => chrome.storage.sync.get("name"))).name === "Chirag NP", 3000)));
check("…and closes the popover", !(await hp.locator(".np-avatar-pop").isVisible()));
const gn = await until(async () => { const n = await guestNames(); return n.people.includes("Chirag NP") && n.tiles.includes("Chirag NP") && n.authors.includes("Chirag NP") && n; }, 6000);
check("the other peer sees the new name (people, camera tile, chat lines)", !!gn, JSON.stringify(await guestNames()));
// blur saves too; empty input is ignored; Esc throws the edit away; long names are cut at 24
await hp.locator(".np-person.np-me").click();
check("people-row avatar opens the same profile, prefilled", (await hp.locator(".np-name-input").inputValue()) === "Chirag NP");
await hp.locator(".np-name-input").fill("Chirag Blur");
await hp.locator(".np-pop-title").click(); // inside the popover: only blurs the field
check("blur saves the name", !!(await until(async () => (await H.sw.evaluate(() => chrome.storage.sync.get("name"))).name === "Chirag Blur", 3000)));
await hp.locator(".np-name-input").fill("   ");
await hp.keyboard.press("Enter");
await sleep(300);
check("empty name is ignored", (await H.sw.evaluate(() => chrome.storage.sync.get("name"))).name === "Chirag Blur");
await hp.locator(".np-person.np-me").click();
check("…and the field shows the saved name again", (await hp.locator(".np-name-input").inputValue()) === "Chirag Blur");
await hp.locator(".np-name-input").fill("Not this one");
await hp.keyboard.press("Escape");
await sleep(300);
check("Esc closes without saving", (await H.sw.evaluate(() => chrome.storage.sync.get("name"))).name === "Chirag Blur" && !(await hp.locator(".np-avatar-pop").isVisible()));
await hp.locator(".np-person.np-me").click();
await hp.locator(".np-name-input").fill("");
await hp.locator(".np-name-input").pressSequentially("Chirag Rasane The Very Long Name");
await hp.keyboard.press("Enter");
check("names are capped at 24 characters (same limit as the popup)", !!(await until(async () => (await H.sw.evaluate(() => chrome.storage.sync.get("name"))).name === "Chirag Rasane The Very L", 3000)), JSON.stringify(await H.sw.evaluate(() => chrome.storage.sync.get("name"))));
check("the guest sees the capped name", !!(await until(async () => (await guestNames()).people.includes("Chirag Rasane The Very L"), 6000)));
check("Enter in the name field didn't reach the site", (await hp.evaluate(() => window.__siteClicks)) === 0);
// from the floating window with the chat closed: the tile name opens the chat and the profile
await shadow(hp, (r) => { r.querySelector(".np-close").click(); });
await sleep(300);
await hp.locator(".np-cam-me").click();
await sleep(400);
check("chat closed: your tile's name opens the chat and 'Your profile'", await shadow(hp, (r) => { return r.querySelector(".np-root").classList.contains("np-open") && r.querySelector(".np-avatar-pop").classList.contains("np-pop-open") && r.activeElement?.classList.contains("np-name-input"); }));
await hp.keyboard.press("Escape");
await H.sw.evaluate(() => chrome.storage.sync.set({ name: "Chirag R" }));
await until(async () => (await guestNames()).people.includes("Chirag R"), 6000);

// camera off → the tile goes away for the other side; the view hides when no cameras
await camBtn(gp).click();
check("guest camera off: host's view drops Rahul", !!(await until(async () => !(await tiles(hp)).some((t) => t.name === "Rahul"), 6000)), JSON.stringify(await tiles(hp)));
check("guest's camera track is stopped (light off)", !!(await until(() => shadow(gp, (r) => { return !r.querySelector(".np-cam video.np-self"); }), 3000)));
await shadow(hp, (r) => { r.querySelector(".np-hang").click(); });
check("host leaves voice: camera off, camera view hidden for both", !!(await until(async () => (await tiles(hp)).length === 0 && (await tiles(gp)).length === 0, 8000)), JSON.stringify([await tiles(hp), await tiles(gp)]));
check("no cameras: normal panel layout restored (WATCHING row, Copy invite)", !!(await until(async () => { const g = await geom(hp); return !g.camdock && g.watching && g.copyPill && !g.headActs; }, 3000)));
// SDP (with its video section) and the camera messages only ever crossed the server encrypted
check("no SDP, ICE or camera state in any WebSocket frame", leaks(T.frames, ["m=video", "m=audio", "a=fingerprint", "candidate:", '"cam"', KEY]).length === 0, JSON.stringify(leaks(T.frames, ["m=video", "m=audio", "a=fingerprint", "candidate:", '"cam"', KEY])));
const bigSig = Math.max(...T.frames.filter((f) => f.dir === "up" && f.text.includes('"type":"signal"')).map((f) => f.text.length));
check("largest encrypted offer fits the 32 KB signal limit", bigSig > 1000 && bigSig < 32768, String(bigSig));

// ---------------------------------------------------------------- camera permission denied
// real permission handling (no auto-accepting fake UI): microphone allowed, camera denied for the site
const C = await launch("/tmp/pw-8c", { name: "Asha", avatar: "🐸", extra: { serverUrl: T.url }, prompts: true });
const cp = await C.ctx.newPage();
const cdp = await C.ctx.newCDPSession(cp);
await cdp.send("Browser.setPermission", { origin: "https://www.netflix.com", permission: { name: "microphone" }, setting: "granted" });
await cdp.send("Browser.setPermission", { origin: "https://www.netflix.com", permission: { name: "camera" }, setting: "denied" });
await cp.goto(created.invite);
await until(async () => !!(await cp.$("a.btn:not([hidden])")), 5000);
await Promise.all([cp.waitForNavigation(), cp.click("a.btn")]);
await until(async () => (await people(cp)).length === 3, 20000);
await shadow(cp, (r) => { r.querySelector(".np-join-voice").click(); });
await until(() => cp.locator(".np-cam-btn").isVisible(), 8000);
await cp.locator(".np-cam-btn").click();
const sys = await until(() => shadow(cp, (r) => { return [...r.querySelectorAll(".np-sys")].map((n) => n.textContent).find((t) => /Camera blocked/.test(t)); }), 6000);
if (!sys) out("C sys:", JSON.stringify(await shadow(cp, (r) => { return [...r.querySelectorAll(".np-sys")].map((n) => n.textContent).slice(-4); })), await cp.locator(".np-cam-btn").getAttribute("aria-pressed"));
check("camera denied: clear message, voice keeps going", !!sys && /allow camera access for www\.netflix\.com/i.test(sys) && (await cp.locator(".np-cam-btn").getAttribute("aria-pressed")) === "false" && (await cp.locator(".np-hang").isVisible()), sys);

// ---------------------------------------------------------------- HiDPI
// every raster image in the overlay and popup is drawn at ≤ 1 image pixel per device pixel
const crisp = async (p, dpr, where) => {
  const r = await p.evaluate((dpr) => {
    const roots = [document, document.getElementById("netparty-root")?.shadowRoot].filter(Boolean);
    const out = [];
    for (const rt of roots)
      for (const i of rt.querySelectorAll("img")) {
        const b = i.getBoundingClientRect();
        if (!b.width) continue;
        const svg = /\.svg(\?|$)/.test(i.currentSrc || i.src);
        if (i.classList.contains("np-gif") || i.classList.contains("np-gif-thumb")) continue; // GIF content from KLIPY
        out.push({ src: (i.currentSrc || i.src).split("/").pop(), ok: svg || i.naturalWidth >= b.width * dpr, nat: i.naturalWidth, css: b.width });
      }
    return out;
  }, dpr);
  check(`${where} (${dpr}x): no raster picture upscaled`, r.every((x) => x.ok), JSON.stringify(r));
};
await crisp(pop, 2, "popup");
await crisp(hp, 2, "host overlay");
await crisp(gp, 3, "guest overlay");
const avatarFonts = await shadow(gp, (r) => { return [...r.querySelectorAll(".np-avatar, .np-mav, .np-avatar-opt")].map((n) => ({ ff: getComputedStyle(n).fontFamily, fs: getComputedStyle(n).fontSize, img: !!n.querySelector("img"), tf: getComputedStyle(n).transform })); });
check("avatars are colour-emoji glyphs (vector/hi-res font), whole-pixel sizes, never images or scaled", avatarFonts.length >= 4 && avatarFonts.every((a) => /Color Emoji|Segoe UI Emoji/.test(a.ff) && /^\d+px$/.test(a.fs) && !a.img && a.tf === "none"), JSON.stringify(avatarFonts.slice(0, 3)));
const icons = await pop.evaluate(() => [...document.querySelectorAll("header img")].map((i) => i.getAttribute("src")));
check("popup header logo is the SVG mark", icons.join() === "icons/mark.svg");
await gp.screenshot({ path: "v18-guest-3x.png" });

check("no script errors", errors.length === 0, errors.join(" | "));
const f = summary("1.8 + 1.9 FEATURE");
T.close();
srv.kill();
await Promise.all([H.ctx.close(), G.ctx.close(), C.ctx.close()]);
process.exit(f ? 1 : 0);
