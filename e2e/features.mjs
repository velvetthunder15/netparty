// 1.6 features e2e (fake Netflix): avatars, emoji picker, 🎉 reactions (incl. fullscreen),
// chat text size, links, GIFs (unavailable without a key; then a mock KLIPY via a second
// local server; with CSP=strict the fake Netflix blocks KLIPY images so the blob: path is used).
import { spawn } from "node:child_process";
import { launch, shadow, until, status, people, check, summary, out, sleep, SERVER } from "./lib.mjs";
const STRICT = process.env.CSP === "strict";
const SITE = "https://www.netflix.com/watch/12345";

const H = await launch("/tmp/pw-fh", { name: "Chirag", avatar: "🦊" });
const G = await launch("/tmp/pw-fg", { name: "Rahul", avatar: "🐼" });
const hp = await H.ctx.newPage(), gp = await G.ctx.newPage();
const errors = [];
for (const [p, n] of [[hp, "host"], [gp, "guest"]]) {
  p.on("pageerror", (e) => (errors.push(n + ": " + e.message), out(n + " pageerror:", e.message)));
  p.on("console", (m) => {
    if (m.type() === "error" && !/Content Security Policy|ERR_|status of 40/.test(m.text())) errors.push(n + " console: " + m.text());
    if (process.env.DEBUG) out(n + " console:", m.text().slice(0, 200));
  });
}
await hp.goto(SITE);
await hp.waitForTimeout(2000);
const created = await H.sw.evaluate(async (url) => {
  const [t] = await chrome.tabs.query({ url: url + "*" });
  return chrome.tabs.sendMessage(t.id, { cmd: "create" });
}, SITE);
check("party created", !!created?.invite, JSON.stringify(created));
await gp.goto(created.invite);
await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
check("guest joined", !!(await until(async () => (await people(gp)).length === 2, 20000)));

// ---- avatars
const pics = (p) => shadow(p, (r) => { return [...r.querySelectorAll(".np-person")].map((n) => n.querySelector(".np-pname").textContent + "=" + n.querySelector(".np-avatar-pic").textContent); });
check("host sees both pictures in the people list", JSON.stringify(await until(async () => { const x = await pics(hp); return x?.includes("You=🦊") && x.includes("Rahul=🐼") && x; })) !== "null", JSON.stringify(await pics(hp)));
check("guest sees both pictures", (await pics(gp)).join() === "Chirag=🦊,You=🐼", JSON.stringify(await pics(gp)));
await gp.locator(".np-input").click();
await gp.keyboard.type("hi from the panda");
await gp.keyboard.press("Enter");
await hp.locator(".np-input").click();
await hp.keyboard.type("hello panda");
await hp.keyboard.press("Enter");
const mav = (p) => shadow(p, (r) => { return [...r.querySelectorAll(".np-msg:not(.np-mine)")].map((m) => m.querySelector(".np-mav")?.textContent + ":" + m.querySelector(".np-bubble").firstChild.textContent); });
check("host chat shows guest's picture next to the message", !!(await until(async () => (await mav(hp)).includes("🐼:hi from the panda"))), JSON.stringify(await mav(hp)));
check("guest chat shows host's picture", !!(await until(async () => (await mav(gp)).includes("🦊:hello panda"))), JSON.stringify(await mav(gp)));
// change mid-party from the panel (click your own picture)
await gp.locator(".np-person.np-me").click();
check("avatar picker opens from the panel", await gp.locator(".np-avatar-pop.np-pop-open").isVisible());
await gp.locator('.np-avatar-opt[data-avatar="🐸"]').click();
check("picker closes after choosing", !(await gp.locator(".np-avatar-pop").isVisible()));
check("host sees the new picture in people + on old chat lines", !!(await until(async () => (await pics(hp)).includes("Rahul=🐸") && (await mav(hp)).includes("🐸:hi from the panda"))), JSON.stringify([await pics(hp), await mav(hp)]));
check("guest's choice saved to storage", (await G.sw.evaluate(() => chrome.storage.sync.get("avatar"))).avatar === "🐸");
// and from the popup's storage (same path the popup uses)
await H.sw.evaluate(() => chrome.storage.sync.set({ avatar: "🍕" }));
check("popup-style change reaches the guest", !!(await until(async () => (await pics(gp)).includes("Chirag=🍕"))));

// ---- emoji picker
await gp.locator(".np-input").click();
await gp.keyboard.type("so good ");
await gp.locator('.np-tool[aria-label="Emoji"]').click();
check("emoji picker open", await gp.locator(".np-emoji-pop.np-pop-open").isVisible());
const popBox = await shadow(gp, (r) => { const p = r.querySelector(".np-panel").getBoundingClientRect(), e = r.querySelector(".np-emoji-pop").getBoundingClientRect(); return { inside: e.left >= p.left && e.right <= p.right && e.top >= 0 && e.bottom <= innerHeight, w: Math.round(e.width), n: r.querySelectorAll(".np-emoji-pop .np-emo-btn").length }; });
check("emoji picker fits inside the panel", popBox.inside, JSON.stringify(popBox));
check("150+ emojis bundled", popBox.n >= 150, String(popBox.n));
await gp.locator('.np-emo-sec[data-cat="smileys"] .np-emo-btn[data-emoji="😂"]').click();
const val1 = await gp.locator(".np-input").inputValue();
check("emoji inserted at the cursor", val1 === "so good 😂", JSON.stringify(val1));
check("chat box kept focus", await shadow(gp, (r) => { return r.activeElement?.classList.contains("np-input"); }));
await gp.evaluate(() => document.getElementById("netparty-root").shadowRoot.querySelector(".np-input").setSelectionRange(0, 0));
await gp.locator('.np-emo-tab[aria-label="Animals & nature"]').click();
await gp.locator('.np-emo-sec[data-cat="animals"] .np-emo-btn[data-emoji="🦄"]').click();
check("insert at caret position (start)", (await gp.locator(".np-input").inputValue()) === "🦄so good 😂");
check("recently used row", (await shadow(gp, (r) => { return [...r.querySelectorAll('[data-cat="recent"] .np-emo-btn')].map((b) => b.textContent).join(""); })) === "🦄😂");
await gp.keyboard.press("Escape");
check("Esc closes the picker, panel stays open", !(await gp.locator(".np-emoji-pop").isVisible()) && (await gp.locator(".np-panel").isVisible()));
await gp.keyboard.press("Enter");
check("message with emoji sent", !!(await until(async () => (await mav(hp)).some((x) => x.endsWith("🦄so good 😂")))));
// outside click closes
await gp.locator('.np-tool[aria-label="Emoji"]').click();
await gp.mouse.click(300, 300);
check("click outside (on the video) closes the picker", !(await gp.locator(".np-emoji-pop").isVisible()));
await gp.locator('.np-tool[aria-label="Emoji"]').click();
await gp.locator(".np-chat").click({ position: { x: 20, y: 20 } });
check("click elsewhere in the panel closes the picker", !(await gp.locator(".np-emoji-pop").isVisible()));
check("no site hotkeys fired while typing", (await gp.evaluate(() => window.__hotkeys)) === 0, String(await gp.evaluate(() => window.__hotkeys)));

// ---- reactions
await hp.locator('.np-tool[aria-label="Reactions"]').click();
const tray = await shadow(hp, (r) => { return [...r.querySelectorAll(".np-react-btn")].map((b) => b.textContent).join(" "); });
check("tray has the 5 default reactions", tray === "😂 😭 💀 🥰 😱", tray);
await hp.locator('.np-react-btn[data-emoji="😂"]').click();
const fly = await until(() => shadow(gp, (r) => { const f = r.querySelector(".np-fly"); return f && f.textContent === "😂" ? f.getBoundingClientRect().top : null; }), 3000, 50);
check("reaction floats on the other user's screen", fly !== null);
await sleep(500);
const fly2 = await shadow(gp, (r) => { const f = r.querySelector(".np-fly"); return f ? f.getBoundingClientRect().top : null; });
check("…and rises", fly2 !== null && fly2 < fly - 20, `${fly} -> ${fly2}`);
const flyX = await shadow(gp, (r) => { const f = r.querySelector(".np-fly").getBoundingClientRect(); const p = r.querySelector(".np-panel").getBoundingClientRect(); return { x: f.left, right: f.right, panelLeft: p.left }; });
check("reaction stays over the video, not the chat column", flyX.right <= flyX.panelLeft, JSON.stringify(flyX));
check("sender sees it too", !!(await shadow(hp, (r) => { return r.querySelector(".np-fly"); })));
await sleep(3500);
check("reaction removed after its animation", (await shadow(gp, (r) => { return r.querySelectorAll(".np-fly").length; })) === 0);
for (let i = 0; i < 9; i++) await hp.locator('.np-react-btn[data-emoji="💀"]').click({ delay: 0 });
await sleep(400);
const nSkull = await shadow(gp, (r) => { return [...r.querySelectorAll(".np-fly")].filter((f) => f.textContent === "💀").length; });
check("rate limit: at most 6 reactions per 3 s", nSkull >= 1 && nSkull <= 6, String(nSkull));
// edit a slot
await hp.locator(".np-react-edit").click();
await hp.locator('.np-react-btn[data-emoji="😭"]').click();
check("edit mode opens the emoji picker for that slot", await hp.locator(".np-emoji-pop.np-replace.np-pop-open").isVisible());
await hp.locator('.np-emo-sec[data-cat="animals"] .np-emo-btn[data-emoji="🔥"]').click();
const tray2 = await shadow(hp, (r) => { return [...r.querySelectorAll(".np-react-btn")].map((b) => b.textContent).join(" "); });
check("slot replaced", tray2 === "😂 🔥 💀 🥰 😱", tray2);
check("custom reactions saved", JSON.stringify((await H.sw.evaluate(() => chrome.storage.sync.get("reactions"))).reactions) === JSON.stringify(["😂", "🔥", "💀", "🥰", "😱"]));
await hp.keyboard.press("Escape");
await hp.locator(".np-input").click();

// ---- chat text size
const fs = (p) => shadow(p, (r) => { const bb = r.querySelector(".np-bubble"), au = r.querySelector(".np-author"); return [getComputedStyle(bb).fontSize, au ? getComputedStyle(au).fontSize : null]; });
check("medium by default (14px)", (await fs(hp))[0] === "14px", JSON.stringify(await fs(hp)));
await hp.locator(".np-tool-font").click();
check("Aa toggle → large (16px), names scale too", JSON.stringify(await fs(hp)) === '["16px","14px"]', JSON.stringify(await fs(hp)));
check("saved", (await H.sw.evaluate(() => chrome.storage.sync.get("chatFont"))).chatFont === "l");
await H.sw.evaluate(() => chrome.storage.sync.set({ chatFont: "s" }));
check("popup setting applies live (small 12px)", !!(await until(async () => (await fs(hp))[0] === "12px")));
await H.sw.evaluate(() => chrome.storage.sync.set({ chatFont: "m" }));

// ---- links
await gp.locator(".np-input").click();
await gp.keyboard.type("look https://example.com/a_b?x=1). and www.test.org, not javascript:alert(1) <img src=x onerror=alert(1)>");
await gp.keyboard.press("Enter");
const links = await until(() => shadow(hp, (r) => {
  const b = [...r.querySelectorAll(".np-bubble")].find((n) => n.textContent.includes("look"));
  return b && { a: [...b.querySelectorAll("a")].map((a) => [a.textContent, a.href, a.target, a.rel]), img: b.querySelectorAll("img").length, text: b.textContent };
}));
check("two links linkified (trailing punctuation stripped, www → https)", JSON.stringify(links?.a?.map((x) => x[1])) === JSON.stringify(["https://example.com/a_b?x=1", "https://www.test.org/"]), JSON.stringify(links));
check("link text keeps what was typed", links?.a?.[1]?.[0] === "www.test.org");
check('target=_blank rel="noopener noreferrer nofollow"', links?.a?.every((x) => x[2] === "_blank" && x[3] === "noopener noreferrer nofollow"));
check("no HTML injected (text stays text)", links?.img === 0 && links.text.includes("<img src=x onerror=alert(1)>"));
const eatenBefore = await hp.evaluate(() => window.__clicksEaten);
const [newTab] = await Promise.all([H.ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null), hp.locator('a.np-a[href="https://example.com/a_b?x=1"]').click()]);
check("clicking a link opens it in a new tab", !!newTab, newTab ? await newTab.evaluate(() => location.href).catch(() => newTab.url()) : "");
check("site's click handler never saw the link click", (await hp.evaluate(() => window.__clicksEaten)) === eatenBefore);
await newTab?.close();
await hp.bringToFront();
const overflow = await shadow(hp, (r) => { const p = r.querySelector(".np-panel"); return { sw: p.scrollWidth, cw: p.clientWidth, chat: r.querySelector(".np-chat").scrollWidth - r.querySelector(".np-chat").clientWidth }; });
check("long links don't overflow the panel", overflow.sw <= overflow.cw && overflow.chat <= 0, JSON.stringify(overflow));

// ---- GIFs: no key on the server → unavailable
await hp.locator(".np-tool-gif").click({ force: true }); // aria-disabled while GIFs are off, still clickable
const off = await until(() => shadow(hp, (r) => { const s = r.querySelector(".np-gif-status"); return s && !s.hidden && s.textContent; }), 6000);
check("no KLIPY key: picker says GIFs aren't available", off === "GIFs aren't available right now.", String(off));
check("GIF button marked unavailable", (await shadow(hp, (r) => { const b = r.querySelector(".np-tool-gif"); return b.getAttribute("aria-disabled") + "|" + b.title; })) === "true|GIFs aren't available right now");
await hp.keyboard.press("Escape");

// ---- GIFs via a mock KLIPY (second local server with a key and KLIPY_BASE)
const srv = spawn(process.execPath, ["server.js"], {
  cwd: "/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/server",
  env: { ...process.env, PORT: "8789", KLIPY_KEY: "test-key", KLIPY_BASE: "http://127.0.0.1:8444" },
  stdio: "ignore",
});
await sleep(1200);
for (const x of [H, G]) await x.sw.evaluate(() => chrome.storage.sync.set({ serverUrl: "ws://localhost:8789" })); // GIF API only; the party socket stays put
await sleep(300);
await hp.locator(".np-tool-gif").click({ force: true }); // aria-disabled while GIFs are off, still clickable
const grid = await until(() => shadow(hp, (r) => { const imgs = [...r.querySelectorAll(".np-gif-thumb")]; return imgs.length >= 8 && imgs.slice(0, 4).every((i) => i.complete && i.naturalWidth > 0) && imgs.length; }), 10000);
check("GIF results render", !!grid, String(grid));
const last = await (await fetch("http://127.0.0.1:8444/__last")).json();
check("search prefilled with the title (relevant to the film)", last?.q === "Fake Movie" && (await hp.locator(".np-gif-input").inputValue()) === "Fake Movie", JSON.stringify(last));
check("key stays on the server", last?.key === "test-key" && !(await hp.content()).includes("test-key"));
const gifUi = await shadow(hp, (r) => { return { ph: r.querySelector(".np-gif-input").placeholder, attr: r.querySelector(".np-klipy").textContent, chips: [...r.querySelectorAll(".np-chip")].map((c) => c.textContent), src: r.querySelector(".np-gif-thumb").src.slice(0, 30) }; });
check("KLIPY attribution: placeholder + Powered by KLIPY", gifUi.ph === "Search KLIPY" && gifUi.attr === "Powered by KLIPY", JSON.stringify(gifUi));
check("quick chips: title, reaction, lol, omg, popcorn", JSON.stringify(gifUi.chips) === JSON.stringify(["Fake Movie", "reaction", "lol", "omg", "popcorn"]), JSON.stringify(gifUi.chips));
check(STRICT ? "strict CSP: thumbnails come from blob: URLs" : "thumbnails load straight from KLIPY", STRICT ? gifUi.src.startsWith("blob:") : gifUi.src.startsWith("https://static.klipy.com/"), gifUi.src);
await hp.locator(".np-chip", { hasText: "lol" }).click();
check("chip searches", !!(await until(async () => (await (await fetch("http://127.0.0.1:8444/__last")).json())?.q === "lol")));
await hp.locator(".np-gif-input").fill("");
await hp.locator(".np-gif-input").type("popcorn time");
await hp.keyboard.press("Enter");
check("typed search (keys don't reach the site)", !!(await until(async () => (await (await fetch("http://127.0.0.1:8444/__last")).json())?.q === "popcorn time")) && (await hp.evaluate(() => window.__hotkeys)) === 0);
await until(() => shadow(hp, (r) => { return r.querySelectorAll(".np-gif-thumb").length >= 8; }));
await shadow(hp, (r) => { const s = r.querySelector(".np-gif-scroll"); s.scrollTop = s.scrollHeight; });
check("scrolling loads more (pos=next)", !!(await until(async () => (await (await fetch("http://127.0.0.1:8444/__last")).json())?.pos === "1")) && !!(await until(() => shadow(hp, (r) => { return r.querySelectorAll(".np-gif-thumb").length >= 16; }))));
await hp.screenshot({ path: STRICT ? "gif-picker-strict.png" : "gif-picker.png" });
await hp.locator(".np-gif-cell").first().click();
check("picker closes after sending", !(await hp.locator(".np-gif-pop").isVisible()));
const gGif = await until(() => shadow(gp, (r) => { const i = r.querySelector(".np-gif"); return i && i.complete && i.naturalWidth > 0 && { src: i.src.slice(0, 40), w: i.width, h: i.height }; }), 10000);
check("GIF shows in the friend's chat", !!gGif, JSON.stringify(gGif));
check(STRICT ? "strict CSP: chat GIF via blob:" : "chat GIF loads from static.klipy.com", !!gGif && (STRICT ? gGif.src.startsWith("blob:") : gGif.src.startsWith("https://static.klipy.com/test/")), JSON.stringify(gGif));
check("GIF fits the bubble (≤ 200 px)", !!gGif && gGif.w <= 200 && gGif.h <= 200);
check("sender sees it too", !!(await until(() => shadow(hp, (r) => { return r.querySelector(".np-mine .np-gif"); }))));
await gp.screenshot({ path: STRICT ? "guest-gif-strict.png" : "guest-gif.png" });

// ---- reactions in fullscreen
await gp.locator(".np-close").click();
await gp.click("#fsbtn");
await sleep(800);
const fsInfo = await gp.evaluate(() => ({ fs: !!document.fullscreenElement, inside: !!document.fullscreenElement?.contains(document.getElementById("netparty-root")) }));
check("guest in fullscreen, overlay moved inside the fullscreen element", fsInfo.fs && fsInfo.inside, JSON.stringify(fsInfo));
await hp.locator('.np-tool[aria-label="Reactions"]').click();
await hp.locator('.np-react-btn[data-emoji="🥰"]').click();
// (hit-test with pointer events briefly on: elementFromPoint skips pointer-events:none)
const fsFly = await until(() => shadow(gp, (r) => { const f = r.querySelector(".np-fly"); if (!f) return null; const b = f.getBoundingClientRect(); const L = r.querySelector(".np-float"); L.style.pointerEvents = f.style.pointerEvents = "auto"; const top = r.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); L.style.pointerEvents = f.style.pointerEvents = ""; return { vis: b.width > 0 && b.bottom > 0 && b.top < innerHeight, onTop: top === f }; }), 3000, 50);
check("reaction visible over the video in fullscreen", !!fsFly?.vis && fsFly.onTop, JSON.stringify(fsFly));
await gp.evaluate(() => document.exitFullscreen());
await sleep(500);

// ---- popup
const extId = H.sw.url().split("/")[2];
const pop = await H.ctx.newPage();
await pop.setViewportSize({ width: 320, height: 640 });
await hp.bringToFront();
await pop.goto(`chrome-extension://${extId}/popup.html`);
await pop.waitForTimeout(600);
check("popup shows your picture", (await pop.locator("#avatarBtn").textContent()) === "🍕");
await pop.click("#avatarBtn");
await pop.click('.avatar-opt[aria-label="Use 🐙"]');
check("popup avatar change reaches the party", !!(await until(async () => (await pics(gp)).includes("Chirag=🐙"))));
await pop.click("#prefs summary");
await pop.click('[data-font="l"]');
check("popup text size applies live in the panel", !!(await until(async () => (await fs(hp))[0] === "16px")));
await pop.click(".slot >> nth=4");
await pop.click('.emoji-opt[aria-label="🍿"]');
check("popup reaction slot saved and shown in the tray", !!(await until(() => shadow(hp, (r) => { return [...r.querySelectorAll(".np-react-btn")].map((b) => b.textContent).join(" ") === "😂 🔥 💀 🥰 🍿"; }))));
const popW = await pop.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
check("popup has no horizontal overflow", popW.sw <= popW.w, JSON.stringify(popW));
await pop.screenshot({ path: "popup-16.png", fullPage: true });
await hp.screenshot({ path: STRICT ? "host-16-strict.png" : "host-16.png" });

check("no script errors on the pages", errors.length === 0, errors.join(" | "));
srv.kill();
const f = summary("FEATURE");
await H.ctx.close();
await G.ctx.close();
process.exit(f ? 1 : 0);
