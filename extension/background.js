// Background service worker: a thin pipe between each streaming tab and the
// party server. Living here (not in the page) keeps the socket clear of
// Netflix's page CSP. One WebSocket per connected tab port.
// Chrome 116+ keeps the worker alive while a WebSocket is active.
// It also fetches GIF search results (from our server) and GIF images (from KLIPY)
// for the page, since sites' CSPs may block those requests from the page itself.
import "./emoji-data.js";

const DEFAULT_SERVER = "wss://netparty.tech";
// KLIPY media hosts (same list as KLIPY_MEDIA_HOSTS in server/core.js)
const GIF_HOSTS = ["static.klipy.com", "static1.klipy.com", "static2.klipy.com"];
const MAX_GIF_BYTES = 8 * 1024 * 1024;

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { serverUrl, name, avatar } = await chrome.storage.sync.get(["serverUrl", "name", "avatar"]);
  const patch = {};
  // builds before 1.0.1 defaulted to a local server; move those (and only those) to the hosted one
  // and 1.5.0 moved the hosted server from workers.dev to netparty.tech (same backend)
  const OLD = ["ws://localhost:8787", "wss://netparty.chiragrasane15.workers.dev"];
  if (!serverUrl || (reason === "update" && OLD.includes(serverUrl))) patch.serverUrl = DEFAULT_SERVER;
  if (!name) patch.name = "Guest " + Math.floor(100 + Math.random() * 900);
  // a random profile picture to start with (changeable in the popup or the chat panel)
  const pics = globalThis.NP_EMOJI?.avatars || [];
  if (!avatar && pics.length) patch.avatar = pics[Math.floor(Math.random() * pics.length)];
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "netparty-socket") return;
  let ws = null;
  let keepAlive = null;

  const close = () => {
    clearInterval(keepAlive);
    keepAlive = null;
    if (ws && ws.readyState <= 1) ws.close(1000);
    ws = null;
  };

  port.onMessage.addListener((msg) => {
    if (msg.cmd === "open") {
      close();
      try {
        ws = new WebSocket(msg.url);
      } catch (e) {
        port.postMessage({ evt: "error", error: String(e) });
        return;
      }
      ws.onopen = () => {
        port.postMessage({ evt: "open" });
        // traffic every 20s keeps the service worker from idling out
        keepAlive = setInterval(() => ws?.readyState === 1 && ws.send('{"type":"ping"}'), 20_000);
      };
      ws.onmessage = (e) => port.postMessage({ evt: "message", data: e.data });
      ws.onerror = () => port.postMessage({ evt: "error", error: "socket error" });
      ws.onclose = (e) => {
        clearInterval(keepAlive);
        port.postMessage({ evt: "close", code: e.code });
      };
    } else if (msg.cmd === "send") {
      if (ws?.readyState === 1) ws.send(msg.data);
    } else if (msg.cmd === "close") {
      close();
    }
  });

  port.onDisconnect.addListener(close);
});

// ---- GIFs
const httpBase = (server) => String(server || DEFAULT_SERVER).replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
async function gifSearch({ server, kind, q, pos }) {
  if (kind !== "search" && kind !== "trending") return { status: 400, body: null };
  const u = new URL(httpBase(server) + "/api/gifs/" + kind);
  if (kind === "search") u.searchParams.set("q", String(q || "").slice(0, 100));
  if (pos) u.searchParams.set("pos", String(pos).slice(0, 200));
  try {
    const res = await fetch(u, { credentials: "omit" });
    let body = null;
    try {
      body = await res.json();
    } catch {}
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}
async function gifMedia(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { error: "bad url" };
  }
  if (u.protocol !== "https:" || !GIF_HOSTS.includes(u.hostname)) return { error: "not allowed" };
  const res = await fetch(u, { credentials: "omit", referrerPolicy: "no-referrer" });
  const type = res.headers.get("content-type") || "image/gif";
  if (!res.ok || !/^image\//.test(type)) return { error: "fetch failed" };
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_GIF_BYTES) return { error: "too big" };
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { dataUrl: `data:${type.split(";")[0]};base64,${btoa(bin)}` };
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // only our own content scripts and pages
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.cmd === "gifs") {
    gifSearch(msg).then(sendResponse);
    return true;
  }
  if (msg?.cmd === "gifMedia") {
    gifMedia(msg.url).then(sendResponse, () => sendResponse({ error: "fetch failed" }));
    return true;
  }
});
