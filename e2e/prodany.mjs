import { tempPath } from "./config.mjs";
// Smoke test of "Sync any video" against the live server (wss://netparty.tech): Chromium host + guest on the
// local test pages (anysite.mjs), party through the popup's injection path, the production invite page
// decrypting the page address, join, pause / seek sync, end. Uses the same test copy of the extension as
// anyvideo.mjs (http://localhost/* in host_permissions stands in for the activeTab grant).
import fs from "node:fs";
import { launch, until, people, check, summary, out, sleep, keyOf, EXT } from "./lib.mjs";
import { start as startPages } from "./anysite.mjs";
const PROD = process.env.TARGET || "wss://netparty.tech";
const A = "http://localhost:8450";
const TEST_EXT = tempPath("np-ext-anyprod");
fs.rmSync(TEST_EXT, { recursive: true, force: true });
fs.cpSync(EXT, TEST_EXT, { recursive: true });
const man = JSON.parse(fs.readFileSync(TEST_EXT + "/manifest.json", "utf8"));
man.host_permissions.push("http://localhost/*");
fs.writeFileSync(TEST_EXT + "/manifest.json", JSON.stringify(man, null, 2));
const stop = startPages();
const H = await launch("pw-prodany-h", { name: "ProdHost", ext: TEST_EXT, extra: { serverUrl: PROD } });
const G = await launch("pw-prodany-g", { name: "ProdGuest", ext: TEST_EXT, extra: { serverUrl: PROD } });
const FILES = ["any-mode.js", "early.js", "emoji-data.js", "qr.js", "anyvideo.js", "content.js"];
const run = (x, page, msg, inject) =>
  x.sw.evaluate(async ([u, m, files, inj]) => {
    const t = (await chrome.tabs.query({})).find((t) => t.url === u);
    if (inj) {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files });
      for (let i = 0; i < 40; i++) {
        const s = await chrome.tabs.sendMessage(t.id, { cmd: "status" }, { frameId: 0 }).catch(() => null);
        if (s?.booted) break;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return chrome.tabs.sendMessage(t.id, m, { frameId: 0 }).catch((e) => ({ error: String(e) }));
  }, [page.url(), msg, FILES, inject]);
const hp = await H.ctx.newPage(), gp = await G.ctx.newPage();
await hp.goto(A + "/plain");
await sleep(1200);
const c = await run(H, hp, { cmd: "create" }, true);
check("prod: any-video party created", !!keyOf(c.invite) && c.invite.startsWith("https://netparty.tech/j/"), String(c.invite).replace(/#k=.*/, "#k=…"));
await gp.goto(c.invite);
const go = await until(() => gp.evaluate(() => { const b = document.getElementById("go"); return b && !b.hidden && b.href; }), 8000);
check("prod invite page decrypts the page address (script allowed by its CSP hash)", go === A + "/plain", String(go));
await gp.goto(go);
await sleep(1200);
const j = await run(G, gp, { cmd: "join", roomId: c.invite.match(/\/j\/([a-z0-9]+)/)[1], key: keyOf(c.invite) }, true);
check("prod: guest joined", j.ok && !!(await until(async () => (await people(gp))?.length === 2, 10000)));
await sleep(2500);
await hp.evaluate(() => window.__v().pause());
check("prod: pause syncs", !!(await until(() => gp.evaluate(() => window.__v().paused), 5000)));
await sleep(2200);
await hp.evaluate(() => { window.__v().currentTime = 40; window.__v().play(); });
check("prod: seek + play sync within 1 s", !!(await until(async () => Math.abs((await gp.evaluate(() => window.__v().currentTime)) - (await hp.evaluate(() => window.__v().currentTime))) < 1 && !(await gp.evaluate(() => window.__v().paused)), 6000)));
await run(H, hp, { cmd: "leave" });
const f = summary("PROD ANY-VIDEO");
stop();
await H.ctx.close();
await G.ctx.close();
process.exit(f ? 1 : 0);
