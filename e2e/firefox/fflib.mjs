// Firefox helpers for the NetParty e2e: real Firefox ESR driven over WebDriver BiDi (puppeteer-core),
// the Firefox build installed as a temporary add-on, fake sites reached through a local CONNECT proxy.
import puppeteer from "puppeteer-core";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
export const BUILD = process.env.BUILD || "/workspace/work/ff/build";
const FAKE_HOSTS = new Set(["www.netflix.com", "www.hotstar.com", "www.jiohotstar.com", "www.youtube.com", "static.klipy.com"]);

// HTTPS proxy: the fake hosts tunnel to the fake site on :8443; anything else is refused
// (keeps Firefox's own background traffic off the network)
let proxy;
export function startProxy(port = 8899) {
  if (proxy) return proxy;
  proxy = http.createServer((q, r) => (r.writeHead(403), r.end()));
  proxy.on("connect", (req, sock, head) => {
    const [host] = req.url.split(":");
    if (!FAKE_HOSTS.has(host)) return sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const up = net.connect(8443, "127.0.0.1", () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  proxy.listen(port);
  return proxy;
}

export async function launchFF(dir, { uuid, prefs = {} } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  startProxy();
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: "/usr/bin/firefox-esr",
    headless: true,
    acceptInsecureCerts: true,
    args: ["-remote-allow-system-access"],
    userDataDir: dir,
    defaultViewport: { width: 1280, height: 720 },
    extraPrefsFirefox: {
      "network.proxy.type": 1,
      "network.proxy.ssl": "127.0.0.1",
      "network.proxy.ssl_port": 8899,
      "network.proxy.no_proxies_on": "localhost, 127.0.0.1",
      "network.proxy.allow_hijacking_localhost": false,
      // fixed moz-extension:// origin so tests can open the popup page
      "extensions.webextensions.uuids": JSON.stringify({ "netparty@netparty.tech": uuid }),
      "media.autoplay.default": 0,
      "media.autoplay.blocking_policy": 0,
      // voice: fake microphone, no permission prompt, host ICE candidates on loopback
      "media.navigator.streams.fake": true,
      "media.navigator.permission.disabled": true,
      "media.peerconnection.ice.loopback": true,
      "media.peerconnection.ice.obfuscate_host_addresses": false,
      "media.peerconnection.ice.default_address_only": false,
      "dom.events.asyncClipboard.clipboardItem": true,
      ...prefs,
    },
  });
  const id = await browser.installExtension(BUILD);
  return { browser, id, base: `moz-extension://${uuid}` };
}

// an extension page (popup.html in a tab) to run chrome.* calls with the add-on's privileges
export async function extPage(x) {
  const p = await x.browser.newPage();
  await p.goto(`${x.base}/popup.html`, { waitUntil: "domcontentloaded", timeout: 8000 }).catch((e) => console.log("ext goto:", e.message));
  return p;
}

// TLS recording proxy in front of the local party server (Firefox's MV3 extension CSP has
// upgrade-insecure-requests, so the add-on talks wss:// only, exactly like with netparty.tech).
import https from "node:https";
import { WebSocket, WebSocketServer } from "/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/server/node_modules/ws/wrapper.mjs";
export function tapTLS(listenPort, targetPort) {
  const frames = [];
  let n = 0;
  const srv = https.createServer({ key: fs.readFileSync("/workspace/work/e2e/key.pem"), cert: fs.readFileSync("/workspace/work/e2e/cert.pem") }, async (req, res) => {
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
      frames.push({ conn, dir: "open", text: "", origin: req.headers.origin || "" });
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
      client.on("close", () => (frames.push({ conn, dir: "close", text: "" }), end()));
      up.on("close", end);
      client.on("error", end);
      up.on("error", end);
    }),
  );
  srv.listen(listenPort);
  return { frames, url: `wss://localhost:${listenPort}`, close: () => (wss.close(), srv.close()) };
}
