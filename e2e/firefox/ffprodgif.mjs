// Prod check: GIF search + KLIPY media from the Firefox add-on (real moz-extension:// origin) against netparty.tech.
import { launchFF, extPage, startProxy } from "./fflib.mjs";
import { check, summary, out } from "/workspace/work/e2e/lib.mjs";
import net from "node:net";
// let the test proxy also tunnel netparty.tech and KLIPY's media hosts to the real internet
const p = startProxy();
p.removeAllListeners("connect");
p.on("connect", (req, sock, head) => {
  const [host, port] = req.url.split(":");
  if (!["netparty.tech", "static.klipy.com", "static1.klipy.com", "static2.klipy.com"].includes(host)) return sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  const up = net.connect(Number(port) || 443, host, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});
const H = await launchFF("/tmp/ff-prodgif", { uuid: "aaaaaaaa-0000-4000-8000-000000000007" });
const e = await extPage(H);
const r = await e.evaluate(() => chrome.runtime.sendMessage({ cmd: "gifs", server: "wss://netparty.tech", kind: "search", q: "popcorn" }));
out("prod search ->", r?.status, r?.body?.results?.length, JSON.stringify(r?.body?.results?.[0] || r?.body).slice(0, 140));
check("prod GIF search works from the Firefox add-on (moz-extension origin)", r?.status === 200 && r.body?.results?.length > 0);
const t = await e.evaluate(() => chrome.runtime.sendMessage({ cmd: "gifs", server: "wss://netparty.tech", kind: "trending" }));
check("prod GIF trending works from the Firefox add-on", t?.status === 200 && t.body?.results?.length > 0, String(t?.status));
const url = r?.body?.results?.[0]?.preview;
const m = url ? await e.evaluate((u) => chrome.runtime.sendMessage({ cmd: "gifMedia", url: u }), url) : null;
check("prod KLIPY image loads through the background", typeof m?.dataUrl === "string" && m.dataUrl.startsWith("data:image/"), JSON.stringify(m).slice(0, 80) + " " + url);
const f = summary("PROD GIF (FIREFOX)");
await H.browser.close(); p.close();
process.exit(f ? 1 : 0);
