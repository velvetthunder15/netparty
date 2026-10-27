// Shared helpers for the NetParty browser e2e suites (features.mjs, youtube.mjs).
import { chromium } from "/workspace/work/pw/node_modules/playwright/index.mjs";
import fs from "node:fs";
import http from "node:http";
import { WebSocket, WebSocketServer } from "/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/server/node_modules/ws/wrapper.mjs";
export const EXT = "/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/extension";
export const SERVER = process.env.SERVER || "ws://localhost:8787";
export const out = (...a) => console.log(...a);
let fails = 0, passes = 0;
export const check = (name, cond, extra = "") => {
  out((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
  cond ? passes++ : fails++;
  return !!cond;
};
export const summary = (label) => {
  out(fails ? `\n${fails} FAILED, ${passes} passed` : `\nALL ${passes} ${label} CHECKS PASSED`);
  return fails;
};
export async function launch(dir, { name, avatar, extra = {}, ctxOpts = {}, args = [], prompts = false } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: "/usr/bin/chromium",
    headless: true,
    viewport: { width: 1280, height: 720 },
    ...ctxOpts,
    args: [
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--host-resolver-rules=MAP www.netflix.com:443 127.0.0.1:8443, MAP www.hotstar.com:443 127.0.0.1:8443, MAP www.youtube.com:443 127.0.0.1:8443, MAP static.klipy.com:443 127.0.0.1:8443, MAP www.primevideo.com:443 127.0.0.1:8443, MAP www.amazon.co.uk:443 127.0.0.1:8443",
      "--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--no-proxy-server",
      // voice chat with a fake microphone; plain host candidates so two local browsers can connect
      "--use-fake-device-for-media-stream", ...(prompts ? [] : ["--use-fake-ui-for-media-stream"]), "--disable-features=WebRtcHideLocalIpsWithMdns",
      ...args,
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  await new Promise((r) => setTimeout(r, 1000)); // let onInstalled finish first
  await sw.evaluate((p) => chrome.storage.sync.set(p), { serverUrl: SERVER, ...(name ? { name } : {}), ...(avatar ? { avatar } : {}), ...extra });
  return { ctx, sw };
}
// run fn(shadowRoot, arg) in the page
export const shadow = (page, fn, arg) =>
  page.evaluate(([f, a]) => {
    const r = document.getElementById("netparty-root")?.shadowRoot;
    return r ? new Function("r", "a", f)(r, a) : null;
  }, [fn.toString().replace(/^[^{]*{|}$/g, ""), arg]);
export async function until(fn, ms = 10000, step = 200) {
  for (let t = 0; t < ms; t += step) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
}
export const status = (x, page) =>
  x.sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => t.url === u) || tabs.find((t) => /netflix|hotstar|youtube|primevideo|amazon/.test(t.url || ""));
    return chrome.tabs.sendMessage(t.id, { cmd: "status" }).catch((e) => ({ error: String(e) }));
  }, page.url());
export const people = (p) => p.evaluate(() => [...(document.getElementById("netparty-root")?.shadowRoot?.querySelectorAll(".np-pname") || [])].map((n) => n.textContent));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const noticeText = (p) => p.evaluate(() => document.getElementById("netparty-notice")?.shadowRoot?.querySelector(".n")?.textContent || "");
// the room key in an invite link (…/j/<code>#k=<key>)
export const keyOf = (invite) => (String(invite).match(/#k=([A-Za-z0-9_-]{43})$/) || [])[1] || null;

// A recording proxy between the extension and the party server: everything the server
// receives and sends, per connection. HTTP (invite pages, GIF API) is passed through too.
export function tap(listenPort, targetPort) {
  const frames = []; // { conn, dir: "up" | "down", text }
  let n = 0;
  const srv = http.createServer(async (req, res) => {
    try {
      const r = await fetch(`http://127.0.0.1:${targetPort}${req.url}`, { method: req.method, headers: { origin: req.headers.origin || "" } });
      const headers = {};
      r.headers.forEach((v, k) => !/^(content-encoding|content-length|transfer-encoding|connection)$/.test(k) && (headers[k] = v));
      res.writeHead(r.status, headers);
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(502);
      res.end(String(e));
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  srv.on("upgrade", (req, sock, head) =>
    wss.handleUpgrade(req, sock, head, (client) => {
      const conn = ++n;
      const up = new WebSocket(`ws://127.0.0.1:${targetPort}${req.url}`);
      const queue = [];
      up.on("open", () => queue.splice(0).forEach((m) => up.send(m)));
      client.on("message", (raw) => {
        const text = raw.toString();
        frames.push({ conn, dir: "up", text });
        up.readyState === 1 ? up.send(text) : queue.push(text);
      });
      up.on("message", (raw) => {
        const text = raw.toString();
        frames.push({ conn, dir: "down", text });
        if (client.readyState === 1) client.send(text);
      });
      const end = () => (client.readyState <= 1 && client.close(), up.readyState <= 1 && up.close());
      client.on("close", end);
      up.on("close", end);
      client.on("error", end);
      up.on("error", end);
    }),
  );
  srv.listen(listenPort);
  return { frames, url: `ws://localhost:${listenPort}`, close: () => (wss.close(), srv.close()) };
}
// which of these strings appear in any recorded frame (empty = nothing leaked)
export const leaks = (frames, needles) => needles.filter((x) => x && frames.some((f) => f.text.includes(x)));
