// 1.8 features e2e (fake Netflix, two real Chromium profiles with fake camera + mic):
//   - your own messages show your picture and name, like everyone else's (and follow changes)
//   - light / dark theme: follows prefers-color-scheme by default, Theme setting in the popup overrides it,
//     persisted; a WCAG contrast audit of every visible text in the panel, pickers, voice bar, camera
//     strip, toast and popup, in both themes
//   - video chat over the voice mesh: camera tiles both ways with live frames, 640x360 / ≤24 fps cap,
//     collapse, drag (stays clear of the docked chat), camera off removes the tile, leaving voice stops
//     the camera, SDP stays encrypted (leak audit), camera permission denied → clear message
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
  res.push(await audit(p, "avatar picker"));
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
check("no camera strip while nobody's camera is on", await shadow(hp, (r) => { return r.querySelector(".np-cams").hidden; }));
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
await camBtn(hp).click();
const gT = await until(() => frames(gp, "Chirag R"), 15000, 500);
check("both cameras on: guest sees the host's live video", !!gT && gT.live, JSON.stringify(await tiles(gp)));
check("guest strip has 2 tiles (you first), count label", JSON.stringify((await tiles(gp)).map((t) => t.name)) === '["You","Chirag R"]' && (await shadow(gp, (r) => { return r.querySelector(".np-cams-count").textContent; })) === "2 cameras");
await hp.screenshot({ path: "v18-cams-host.png" });

// contrast in both themes, with everything on screen (host: light; guest: dark via System)
await gp.emulateMedia({ colorScheme: "dark" });
const lightRes = await surfaces(hp);
const darkRes = await surfaces(gp);
for (const r of [...lightRes, ...darkRes.map((x) => ({ ...x, label: "dark " + x.label }))]) check(`contrast ≥ AA: ${r.label} (${r.n} texts)`, r.n > 0 && !r.bad.length, r.bad.join(" | "));
// toast (panel closed, a message arrives) in light
await shadow(hp, (r) => { r.querySelector(".np-close").click(); });
await gp.locator(".np-input").click();
await gp.keyboard.type("toast in light mode");
await gp.keyboard.press("Enter");
await sleep(600);
const toastRes = await audit(hp, "toast + camera strip (light)");
check(`contrast ≥ AA: ${toastRes.label} (${toastRes.n} texts)`, toastRes.n >= 3 && !toastRes.bad.length, toastRes.bad.join(" | "));
await hp.screenshot({ path: "v18-light-closed.png" });
await shadow(hp, (r) => { r.querySelector(".np-toggle").click(); });
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

// collapse + drag
await hp.locator(".np-cams-btn").click();
const col = await shadow(hp, (r) => { const c = r.querySelector(".np-cams"); return { min: c.classList.contains("np-cams-min"), body: getComputedStyle(c.querySelector(".np-cams-body")).display, h: Math.round(c.getBoundingClientRect().height), exp: c.querySelector(".np-cams-btn").getAttribute("aria-expanded") }; });
check("collapse hides the tiles, keeps the bar", col.min && col.body === "none" && col.h < 44 && col.exp === "false", JSON.stringify(col));
await hp.locator(".np-cams-btn").click();
const bar = await shadow(hp, (r) => { const b = r.querySelector(".np-cams-bar").getBoundingClientRect(), c = r.querySelector(".np-cams").getBoundingClientRect(); return { x: b.left + 30, y: b.top + 8, left: c.left, top: c.top }; });
const vBefore = await hp.evaluate(() => document.querySelector("video").paused);
await hp.mouse.move(bar.x, bar.y);
await hp.mouse.down();
await hp.mouse.move(bar.x + 300, bar.y - 200, { steps: 8 });
await hp.mouse.up();
const moved = await shadow(hp, (r) => { const c = r.querySelector(".np-cams").getBoundingClientRect(); return { x: Math.round(c.left), y: Math.round(c.top) }; });
check("drag moves the strip with the pointer", Math.abs(moved.x - (bar.left + 300)) < 3 && Math.abs(moved.y - (bar.top - 200)) < 3, JSON.stringify([bar, moved]));
check("its place is remembered for the tab", await hp.evaluate(() => { const s = JSON.parse(sessionStorage.getItem("netpartyCams") || "{}"); return Number.isFinite(s.x) && Number.isFinite(s.y); }));
await hp.mouse.move(moved.x + 30, moved.y + 8);
await hp.mouse.down();
await hp.mouse.move(1270, 700, { steps: 8 });
await hp.mouse.up();
const clamped = await shadow(hp, (r) => { const c = r.querySelector(".np-cams").getBoundingClientRect(), p = r.querySelector(".np-panel").getBoundingClientRect(); return { right: Math.round(c.right), bottom: Math.round(c.bottom), panelLeft: Math.round(p.left), vw: innerWidth, vh: innerHeight }; });
check("it can be dragged over the docked chat and still stays on screen", clamped.right > clamped.panelLeft && clamped.right <= clamped.vw && clamped.bottom <= clamped.vh, JSON.stringify(clamped));
const onTop = await shadow(hp, (r) => { const c = r.querySelector(".np-cams").getBoundingClientRect(); const hit = r.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2); return !!hit && !!hit.closest(".np-cams"); });
check("over the chat, the camera strip draws above the chat panel", onTop);
await hp.screenshot({ path: "v18-cams-over-chat.png" });
check("dragging the strip didn't pause/play the video", (await hp.evaluate(() => document.querySelector("video").paused)) === vBefore);

// camera off → the tile goes away for the other side; strip hides when no cameras
await camBtn(gp).click();
check("guest camera off: host's strip drops Rahul", !!(await until(async () => !(await tiles(hp)).some((t) => t.name === "Rahul"), 6000)), JSON.stringify(await tiles(hp)));
check("guest's camera track is stopped (light off)", !!(await until(() => shadow(gp, (r) => { return !r.querySelector(".np-cam video.np-self"); }), 3000)));
await shadow(hp, (r) => { r.querySelector(".np-hang").click(); });
check("host leaves voice: camera off, strip hidden for both", !!(await until(async () => (await tiles(hp)).length === 0 && (await tiles(gp)).length === 0, 8000)), JSON.stringify([await tiles(hp), await tiles(gp)]));

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
const f = summary("1.8 FEATURE");
T.close();
srv.kill();
await Promise.all([H.ctx.close(), G.ctx.close(), C.ctx.close()]);
process.exit(f ? 1 : 0);
