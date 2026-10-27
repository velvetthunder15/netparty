// GIFs in Firefox: background fetch of the GIF API (CORS from a moz-extension:// origin) and KLIPY media,
// then the picker in the panel. Second local server with a KLIPY key pointed at the mock KLIPY on :8444.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import { spawn } from "node:child_process";
import { launchFF, extPage, tapTLS } from "./fflib.mjs";
import { shadow, until, check, summary, out, sleep } from "/workspace/work/e2e/lib.mjs";
const T = tapTLS(8792, 8787);
const srv = spawn(process.execPath, ["server.js"], { cwd: "/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/server", env: { ...process.env, PORT: "8789", KLIPY_KEY: "test-key", KLIPY_BASE: "http://127.0.0.1:8444" }, stdio: "ignore" });
const G2 = tapTLS(8793, 8789);
await sleep(1200);
const H = await launchFF("/tmp/ff-gif", { uuid: "aaaaaaaa-0000-4000-8000-000000000003" });
const he = await extPage(H);
await he.evaluate((u) => chrome.storage.sync.set({ serverUrl: u, name: "Chirag" }), T.url);
const direct = await he.evaluate((s) => chrome.runtime.sendMessage({ cmd: "gifs", server: s, kind: "trending" }), G2.url);
out("background gif search ->", JSON.stringify(direct).slice(0, 160));
check("background GIF API fetch works from Firefox (CORS for moz-extension:// origin)", direct?.status === 200 && Array.isArray(direct?.body?.results) && direct.body.results.length > 0, JSON.stringify(direct).slice(0, 200));
const media = await he.evaluate(() => chrome.runtime.sendMessage({ cmd: "gifMedia", url: "https://static.klipy.com/test/1.gif" }));
check("background KLIPY media fetch works (host permission)", typeof media?.dataUrl === "string" && media.dataUrl.startsWith("data:image/gif;base64,"), JSON.stringify(media).slice(0, 100));
const hp = await H.browser.newPage();
await hp.goto("https://www.netflix.com/watch/12345", { waitUntil: "domcontentloaded" });
await sleep(2500);
const created = await he.evaluate(async () => { const tabs = await chrome.tabs.query({}); const t = tabs.find((t) => /netflix/.test(t.url || "")); return chrome.tabs.sendMessage(t.id, { cmd: "create" }); });
check("party created", !!created?.invite, JSON.stringify(created));
await he.evaluate((u) => chrome.storage.sync.set({ serverUrl: u }), G2.url); // GIF API only; the party socket stays put
await sleep(400);
await shadow(hp, (r) => { r.querySelector(".np-tool-gif").click(); });
const grid = await until(() => shadow(hp, (r) => { const imgs = [...r.querySelectorAll(".np-gif-thumb")]; return imgs.length >= 8 && imgs.slice(0, 4).every((i) => i.complete && i.naturalWidth > 0) && { n: imgs.length, src: imgs[0].src.slice(0, 32) }; }), 10000);
check("GIF picker renders results in Firefox", !!grid, JSON.stringify(grid) + " status=" + (await shadow(hp, (r) => { return r.querySelector(".np-gif-status")?.textContent; })));
const f = summary("FIREFOX GIF");
await H.browser.close(); T.close(); G2.close(); srv.kill();
process.exit(f ? 1 : 0);
