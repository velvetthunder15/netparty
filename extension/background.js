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
  // (2.2: one of the bundled HD pictures, "av:<slug>")
  const pics = (globalThis.NP_EMOJI?.hd || []).map((x) => "av:" + x.id);
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
// 2.2 HD profile pictures: the bundled avatars/av-<slug>.webp as a data: URL, so the content script
// can draw it without the files being web-accessible (no page can probe for them) and whatever the
// page's CSP allows (blob:, data: or a canvas). Only slugs from the bundled list.
const avatarCache = new Map();
async function avatarFile(id) {
  if (typeof id !== "string" || !(globalThis.NP_EMOJI?.hd || []).some((x) => x.id === id)) return { error: "unknown" };
  if (!avatarCache.has(id)) {
    const res = await fetch(chrome.runtime.getURL("avatars/av-" + id + ".webp"));
    if (!res.ok) return { error: "missing" };
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    avatarCache.set(id, "data:image/webp;base64," + btoa(bin));
  }
  return { dataUrl: avatarCache.get(id) };
}
// ---- room keys (end-to-end encryption). Each tab's party key is kept in chrome.storage.session:
// in memory only (never written to disk, never synced to Google, gone when the browser closes),
// and out of reach of the streaming site's own scripts. Keyed by tab and party code, so reloads,
// episode changes and reconnects keep it; deleted when the party ends, the tab leaves it or closes.
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[a-z0-9]{4,16}$/;
const keyName = (tabId, code) => `rk:${tabId}:${code}`;
async function roomKey(msg, tabId) {
  const code = String(msg.code || "");
  if (!CODE_RE.test(code)) return { error: "bad code" };
  const k = keyName(tabId, code);
  if (msg.op === "set") {
    if (!KEY_RE.test(String(msg.key || ""))) return { error: "bad key" };
    await chrome.storage.session.set({ [k]: msg.key });
    return { ok: true };
  }
  if (msg.op === "get") return { key: (await chrome.storage.session.get(k))[k] || null };
  if (msg.op === "del") {
    await chrome.storage.session.remove(k);
    return { ok: true };
  }
  return { error: "bad op" };
}
async function tabKeys(tabId) {
  const all = await chrome.storage.session.get(null);
  return Object.keys(all).filter((k) => k.startsWith(`rk:${tabId}:`)).map((k) => [k, all[k]]);
}
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const ks = await tabKeys(tabId);
  if (ks.length) await chrome.storage.session.remove(ks.map(([k]) => k));
});
// a tab swapped for a prerendered one gets a new id: its keys move with it
chrome.tabs.onReplaced.addListener(async (added, removed) => {
  const ks = await tabKeys(removed);
  if (!ks.length) return;
  await chrome.storage.session.set(Object.fromEntries(ks.map(([k, v]) => [k.replace(`rk:${removed}:`, `rk:${added}:`), v])));
  await chrome.storage.session.remove(ks.map(([k]) => k));
});

// ---- "Sync any video" (2.0)
// NetParty runs on a page that isn't one of the supported services only after the user asks for it:
// "Sync this tab" injects the scripts into that tab once (activeTab). "Always allow on this site" asks the
// browser for that one site (an optional host permission) and registers the scripts for it here, so
// reloads keep the party. Removing the site's access (in the popup or the browser's own settings)
// unregisters them.
const ANY_FILES_START = ["any-mode.js", "early.js"];
const ANY_FILES_IDLE = ["any-mode.js", "emoji-data.js", "anyvideo.js", "content.js"];
const anyId = (origin, part) => "npany-" + part + "-" + origin.replace(/[^A-Za-z0-9]/g, "_");
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
// the permission / match pattern for a site: scheme + host, any port (Firefox's match patterns can't name a port)
const patternOf = (origin) => {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
};
async function anyOrigins() {
  const { anyOrigins: list } = await chrome.storage.local.get("anyOrigins");
  return Array.isArray(list) ? list.filter((o) => typeof o === "string" && ORIGIN_RE.test(o)) : [];
}
async function registerAny(origin) {
  const matches = [patternOf(origin)];
  const all = [
    { id: anyId(origin, "a"), matches, js: ANY_FILES_START, runAt: "document_start", allFrames: false, persistAcrossSessions: true },
    { id: anyId(origin, "b"), matches, js: ANY_FILES_IDLE, runAt: "document_idle", allFrames: false, persistAcrossSessions: true },
  ];
  const have = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
  const want = all.filter((s) => !have.has(s.id));
  if (!want.length) return;
  try {
    await chrome.scripting.registerContentScripts(want);
  } catch {
    // older Firefox builds don't know persistAcrossSessions; syncAny() registers again at startup
    await chrome.scripting.registerContentScripts(want.map(({ persistAcrossSessions, ...s }) => s));
  }
}
async function unregisterAny(origin) {
  const ids = [anyId(origin, "a"), anyId(origin, "b")];
  const have = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
  const drop = ids.filter((id) => have.has(id));
  if (drop.length) await chrome.scripting.unregisterContentScripts({ ids: drop }).catch(() => {});
}
// the sites the user allowed, still allowed by the browser, each with its scripts registered
async function syncAny() {
  const keep = [];
  for (const o of await anyOrigins()) {
    if (await chrome.permissions.contains({ origins: [patternOf(o)] }).catch(() => false)) {
      keep.push(o);
      await registerAny(o).catch(() => {});
    } else await unregisterAny(o);
  }
  await chrome.storage.local.set({ anyOrigins: keep });
  return keep;
}
async function allowAny(origin) {
  if (!ORIGIN_RE.test(origin)) return { error: "bad origin" };
  if (!(await chrome.permissions.contains({ origins: [patternOf(origin)] }))) return { error: "not allowed" };
  const list = await anyOrigins();
  if (!list.includes(origin)) await chrome.storage.local.set({ anyOrigins: [...list, origin] });
  await registerAny(origin);
  return { ok: true };
}
async function forgetAny(origin) {
  if (!ORIGIN_RE.test(origin)) return { error: "bad origin" };
  await chrome.storage.local.set({ anyOrigins: (await anyOrigins()).filter((o) => o !== origin) });
  await unregisterAny(origin);
  // the site's access too, unless the extension needs it anyway (a supported service)
  const fixed = chrome.runtime.getManifest().host_permissions || [];
  // (unless another allowed site shares the pattern, or the extension needs it anyway: a supported service)
  const pat = patternOf(origin);
  const shared = (await anyOrigins()).some((o) => patternOf(o) === pat);
  if (!fixed.includes(pat) && !shared) await chrome.permissions.remove({ origins: [pat] }).catch(() => {});
  return { ok: true };
}
chrome.permissions.onRemoved.addListener(() => syncAny().catch(() => {}));
// the popup may close while the browser shows its permission prompt (Firefox): finish "Always allow" here.
// Only for a site the popup just asked about (a player's site allowed for one video isn't registered).
chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  for (const pat of origins) {
    const k = "anyWant:" + pat;
    const want = (await chrome.storage.session.get(k).catch(() => ({})))[k];
    if (!want || typeof want.origin !== "string") continue;
    await chrome.storage.session.remove(k).catch(() => {});
    if (Date.now() - want.ts < 5 * 60 * 1000) await allowAny(want.origin).catch(() => {});
  }
});
chrome.runtime.onStartup?.addListener(() => syncAny().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => syncAny().catch(() => {}));

// A video inside a cross-origin iframe: anyvideo.js runs there as an agent (only after the user allowed
// that frame's site). The tab's main script (top frame) and the agent talk through here, by tab and frame.
async function relayToFrame(tabId, frameId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId });
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // only our own content scripts and pages
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.cmd === "npFrame") {
    // agent (a subframe) -> the tab's main script
    if (!sender.tab || !Number.isInteger(sender.frameId) || sender.frameId === 0) return;
    let origin = null;
    try {
      origin = new URL(sender.url).origin;
    } catch {}
    relayToFrame(sender.tab.id, 0, { cmd: "npFrameEvt", frameId: sender.frameId, origin, op: msg.op, kind: msg.kind, rate: msg.rate, w: msg.w, h: msg.h, again: msg.again === true });
    return;
  }
  if (msg?.cmd === "npAgent") {
    // the tab's main script -> one of its frames' agents
    if (!sender.tab || sender.frameId !== 0 || !Number.isInteger(msg.frameId) || msg.frameId === 0) return sendResponse(null);
    const { cmd, op, position, rate, nudge, on, vol } = msg;
    relayToFrame(sender.tab.id, msg.frameId, { cmd, op, position, rate, nudge, on, vol }).then(sendResponse);
    return true;
  }
  if (msg?.cmd === "anyAllow" || msg?.cmd === "anyForget") {
    // from the popup (an extension page), never from a content script
    if (!String(sender.url || "").startsWith(chrome.runtime.getURL(""))) return sendResponse({ error: "not allowed" });
    (msg.cmd === "anyAllow" ? allowAny : forgetAny)(String(msg.origin || "")).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  if (msg?.cmd === "roomKey") {
    // content scripts only: the key belongs to the tab it came from
    if (!sender.tab || !Number.isInteger(sender.tab.id)) return sendResponse({ error: "no tab" });
    roomKey(msg, sender.tab.id).then(sendResponse, () => sendResponse({ error: "storage" }));
    return true;
  }
  if (msg?.cmd === "gifs") {
    gifSearch(msg).then(sendResponse);
    return true;
  }
  if (msg?.cmd === "gifMedia") {
    gifMedia(msg.url).then(sendResponse, () => sendResponse({ error: "fetch failed" }));
    return true;
  }
  if (msg?.cmd === "avatarFile") {
    avatarFile(msg.id).then(sendResponse, () => sendResponse({ error: "fetch failed" }));
    return true;
  }
});
