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
  let openTimer = null;
  let gone = false;
  // the port may be gone by the time a socket event fires (the tab closed or navigated)
  const post = (m) => {
    if (gone) return;
    try {
      port.postMessage(m);
    } catch {
      gone = true;
    }
  };

  // 2.4: a replaced socket is detached before it's closed, so its late "close" can't be taken for the new one's
  const close = () => {
    clearInterval(keepAlive);
    clearTimeout(openTimer);
    keepAlive = openTimer = null;
    const old = ws;
    ws = null;
    if (!old) return;
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    if (old.readyState <= 1) old.close(1000);
  };

  port.onMessage.addListener((msg) => {
    if (msg.cmd === "open") {
      // each open is numbered by the tab (2.4); every event of this socket carries that number
      const gen = Number.isInteger(msg.gen) ? msg.gen : undefined;
      close();
      let sock;
      try {
        sock = ws = new WebSocket(msg.url);
      } catch (e) {
        ws = null;
        post({ evt: "error", error: String(e), gen });
        post({ evt: "close", code: 1006, gen });
        return;
      }
      // a handshake that hangs (a network switch, a captive portal) is given up on, so the tab tries again
      openTimer = setTimeout(() => {
        if (ws !== sock || sock.readyState !== 0) return;
        close();
        post({ evt: "close", code: 4008, gen });
      }, 12_000);
      sock.onopen = () => {
        clearTimeout(openTimer);
        post({ evt: "open", gen });
        // traffic every 20s keeps the service worker from idling out
        keepAlive = setInterval(() => sock.readyState === 1 && sock.send('{"type":"ping"}'), 20_000);
      };
      sock.onmessage = (e) => post({ evt: "message", data: e.data, gen });
      sock.onerror = () => post({ evt: "error", error: "socket error", gen });
      sock.onclose = (e) => {
        if (ws === sock) {
          clearInterval(keepAlive);
          clearTimeout(openTimer);
          ws = null;
        }
        post({ evt: "close", code: e.code, gen });
      };
    } else if (msg.cmd === "send") {
      if (ws?.readyState === 1) ws.send(msg.data);
    } else if (msg.cmd === "close") {
      close();
    }
  });

  port.onDisconnect.addListener(() => {
    gone = true;
    close();
  });
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
// 2.3 Invite friends: the apps' own start pages (the popup and the panel copy the link first)
const SHARE_APPS = Object.freeze({
  whatsapp: "https://web.whatsapp.com/",
  discord: "https://discord.com/channels/@me",
  instagram: "https://www.instagram.com/direct/inbox/",
});
// 2.3: the party recap's running totals for a tab (counts, names and pictures of who was there, the title),
// kept the same way as the keys: chrome.storage.session, out of the site's reach, deleted with the tab. The
// recap image itself is only ever drawn in the tab.
const RECAP_MAX = 64 * 1024; // characters of JSON
async function recapStore(msg, tabId) {
  const code = String(msg.code || "");
  if (!CODE_RE.test(code)) return { error: "bad code" };
  const k = `rc:${tabId}:${code}`;
  if (msg.op === "set") {
    const d = msg.data;
    if (!d || typeof d !== "object" || Array.isArray(d) || JSON.stringify(d).length > RECAP_MAX) return { error: "bad recap" };
    await chrome.storage.session.set({ [k]: d });
    return { ok: true };
  }
  if (msg.op === "get") return { data: (await chrome.storage.session.get(k))[k] || null };
  if (msg.op === "del") {
    await chrome.storage.session.remove(k);
    return { ok: true };
  }
  return { error: "bad op" };
}
// 2.3: the chat panel's QR code. The panel sits inside the site's page, where the site could read a canvas, and
// the invite link carries the party's key, so the panel hands the link to us and we show it in our own page
// (qr.html, in a small window). Kept as "qr:<tab>:" { link, win } until the party ends there or the tab closes.
function cleanInvite(s) {
  if (typeof s !== "string" || s.length > 300) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  return /^https?:$/.test(u.protocol) && !u.search && !u.username && !u.password && /\/j\/[a-z0-9]{4,16}$/.test(u.pathname) && /^#k=[A-Za-z0-9_-]{43}$/.test(u.hash) ? u.href : null;
}
const qrKey = (tabId) => `qr:${tabId}:`;
async function qrClose(tabId) {
  const k = qrKey(tabId);
  const cur = (await chrome.storage.session.get(k))[k];
  await chrome.storage.session.remove(k);
  if (Number.isInteger(cur?.win)) await chrome.windows.remove(cur.win).catch(() => {});
}
async function qrOpen(tabId, link) {
  const k = qrKey(tabId);
  const cur = (await chrome.storage.session.get(k))[k];
  // already showing: the same window, with this link
  if (Number.isInteger(cur?.win)) {
    const w = await chrome.windows.get(cur.win, { populate: true }).catch(() => null);
    const t = w?.tabs?.[0];
    if (t && String(t.url || "").startsWith(chrome.runtime.getURL("qr.html"))) {
      await chrome.storage.session.set({ [k]: { link, win: cur.win } });
      await chrome.tabs.reload(t.id).catch(() => {});
      await chrome.windows.update(cur.win, { focused: true }).catch(() => {});
      return;
    }
  }
  await chrome.storage.session.set({ [k]: { link, win: null } });
  const w = await chrome.windows.create({ url: chrome.runtime.getURL(`qr.html?tab=${tabId}`), type: "popup", width: 380, height: 500, focused: true });
  await chrome.storage.session.set({ [k]: { link, win: w?.id ?? null } });
}
chrome.windows.onRemoved.addListener(async (winId) => {
  const all = await chrome.storage.session.get(null);
  const ks = Object.keys(all).filter((k) => k.startsWith("qr:") && all[k]?.win === winId);
  if (ks.length) await chrome.storage.session.remove(ks);
});

async function tabKeys(tabId) {
  const all = await chrome.storage.session.get(null);
  return Object.keys(all).filter((k) => k.startsWith(`rk:${tabId}:`) || k.startsWith(`rc:${tabId}:`) || k === qrKey(tabId)).map((k) => [k, all[k]]);
}
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const ks = await tabKeys(tabId);
  if (ks.some(([k]) => k === qrKey(tabId))) await qrClose(tabId);
  if (ks.length) await chrome.storage.session.remove(ks.map(([k]) => k));
});
// a tab swapped for a prerendered one gets a new id: its keys (and recap) move with it (an open QR code window
// belongs to the old one and is closed)
chrome.tabs.onReplaced.addListener(async (added, removed) => {
  if ((await tabKeys(removed)).some(([k]) => k === qrKey(removed))) await qrClose(removed);
  const ks = await tabKeys(removed);
  if (!ks.length) return;
  await chrome.storage.session.set(Object.fromEntries(ks.map(([k, v]) => [k.replace(/^(r[kc]):\d+:/, `$1:${added}:`), v])));
  await chrome.storage.session.remove(ks.map(([k]) => k));
});

// ---- "Sync any video" (2.0)
// NetParty runs on a page that isn't one of the supported services only after the user asks for it:
// "Sync this tab" injects the scripts into that tab once (activeTab). "Always allow on this site" asks the
// browser for that one site (an optional host permission) and registers the scripts for it here, so
// reloads keep the party. Removing the site's access (in the popup or the browser's own settings)
// unregisters them.
const ANY_FILES_START = ["any-mode.js", "early.js"];
const ANY_FILES_IDLE = ["any-mode.js", "emoji-data.js", "qr.js", "anyvideo.js", "content.js"];
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

// ---- 2.4 updates and "What's new"
// The party server says which version is current (GET /api/version: the version of the extension it serves,
// and a few words on what's in it). When ours is older, the toolbar icon gets a badge, the popup shows an Update
// card and the supported sites show a small reminder (once a day) until this browser runs the new version.
// "Update now" does what this kind of install allows: the store builds (Edge, Firefox) ask their store for the
// update and restart into it; the zip build opens the download page, and its Reload button picks up the new
// files once they're unzipped over the old ones. After an update, the popup and the next supported page show
// the new version's "What's new" once. Nothing is sent but the request itself (no id, no version of ours).
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const SITE_BASE = "https://netparty.tech";
const STORES = {
  firefox: "https://addons.mozilla.org/en-US/firefox/addon/netparty/",
  edge: "https://microsoftedge.microsoft.com/addons/detail/netparty/cbbgchcialmecjommdohdfmolliinjki",
};
const VERSION_RE = /^\d{1,4}(\.\d{1,4}){0,3}$/;
const myVersion = () => chrome.runtime.getManifest().version;
// -1, 0, 1 for dotted versions ("2.10.0" > "2.9.1")
function cmpVersion(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
const cleanNotes = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === "string" && s.trim()).slice(0, 3).map((s) => s.trim().slice(0, 80)) : []);
// how this copy was installed: "store" (it can update itself) or "zip" (unpacked / sideloaded)
async function installKind() {
  try {
    const self = await chrome.management.getSelf();
    return self.installType === "normal" || self.installType === "admin" ? "store" : "zip";
  } catch {
    // (Chrome and Edge add update_url to the manifest of store installs)
    return chrome.runtime.getManifest().update_url ? "store" : "zip";
  }
}
const browserKind = () => (/Firefox\//.test(navigator.userAgent) ? "firefox" : /Edg\//.test(navigator.userAgent) ? "edge" : "chrome");
async function showBadge() {
  const { update, whatsNew } = await chrome.storage.local.get(["update", "whatsNew"]);
  const behind = !!update?.version && cmpVersion(update.version, myVersion()) > 0;
  await chrome.action.setBadgeText({ text: behind ? "↑" : whatsNew && !whatsNew.seen ? "NEW" : "" }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: behind ? "#e8590c" : "#7c5cff" }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ color: "#ffffff" })?.catch?.(() => {});
  await chrome.action.setTitle({ title: behind ? `NetParty: version ${update.version} is out. Click to update.` : "NetParty" }).catch(() => {});
}
async function checkUpdate(force = false) {
  const { update, updateCheckedAt, serverUrl } = { ...(await chrome.storage.local.get(["update", "updateCheckedAt"])), ...(await chrome.storage.sync.get("serverUrl")) };
  if (!force && Date.now() - (updateCheckedAt || 0) < CHECK_EVERY_MS) return update || null;
  await chrome.storage.local.set({ updateCheckedAt: Date.now() });
  let info = null;
  try {
    const res = await fetch(httpBase(serverUrl) + "/api/version", { credentials: "omit", cache: "no-store" });
    if (res.ok) info = await res.json();
  } catch {}
  if (!info || !VERSION_RE.test(String(info.version || ""))) return update || null;
  if (cmpVersion(info.version, myVersion()) <= 0) {
    await chrome.storage.local.remove("update");
    await showBadge();
    return null;
  }
  const next = { version: info.version, notes: cleanNotes(info.notes), ready: update?.version === info.version && update.ready === true, since: update?.version === info.version ? update.since : Date.now() };
  await chrome.storage.local.set({ update: next });
  await showBadge();
  // a store build: ask the store now, so the update is often ready by the time someone clicks
  if ((await installKind()) === "store") chrome.runtime.requestUpdateCheck?.()?.catch?.(() => {});
  return next;
}
// the store has the new version downloaded and waiting for a restart
chrome.runtime.onUpdateAvailable?.addListener(async (details) => {
  const { update } = await chrome.storage.local.get("update");
  const version = VERSION_RE.test(String(details?.version || "")) ? details.version : update?.version;
  if (!version) return;
  await chrome.storage.local.set({ update: { ...(update || {}), version, notes: update?.notes || [], ready: true, since: update?.since || Date.now() } });
  await showBadge();
});
async function updateNow() {
  const { update } = await chrome.storage.local.get("update");
  if (update?.ready) {
    chrome.runtime.reload();
    return { ok: true, reloading: true };
  }
  const kind = await installKind();
  if (kind === "store" && chrome.runtime.requestUpdateCheck) {
    let status = null;
    try {
      const r = await chrome.runtime.requestUpdateCheck();
      status = r?.status ?? (Array.isArray(r) ? r[0] : r);
    } catch {}
    if (status === "update_available") {
      // downloading; onUpdateAvailable marks it ready. Restart once it's in.
      for (let t = 0; t < 15000; t += 500) {
        await new Promise((r) => setTimeout(r, 500));
        if ((await chrome.storage.local.get("update")).update?.ready) {
          chrome.runtime.reload();
          return { ok: true, reloading: true };
        }
      }
      return { ok: true, pending: true };
    }
    const store = STORES[browserKind()];
    if (store) await chrome.tabs.create({ url: store }).catch(() => {});
    return { ok: true, opened: "store" };
  }
  await chrome.tabs.create({ url: SITE_BASE + "/#install" }).catch(() => {});
  return { ok: true, opened: "download", zip: true };
}
async function updateInfo() {
  const update = await checkUpdate().catch(() => null);
  const { whatsNew, updateNagAt } = await chrome.storage.local.get(["whatsNew", "updateNagAt"]);
  return {
    version: myVersion(),
    update: update && cmpVersion(update.version, myVersion()) > 0 ? update : null,
    kind: await installKind(),
    nagAt: updateNagAt || 0,
    whatsNew: whatsNew && !whatsNew.seen && whatsNew.version === myVersion() ? whatsNew : null,
  };
}
async function loadWhatsNew() {
  try {
    const w = await (await fetch(chrome.runtime.getURL("whats-new.json"))).json();
    return { version: myVersion(), items: w.version === myVersion() ? cleanNotes(w.items) : [] };
  } catch {
    return { version: myVersion(), items: [] };
  }
}
chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  const { update } = await chrome.storage.local.get("update");
  // running the new version now: the reminder is done
  if (update?.version && cmpVersion(update.version, myVersion()) <= 0) await chrome.storage.local.remove("update");
  if (reason === "update" && previousVersion && cmpVersion(myVersion(), previousVersion) > 0) {
    const w = await loadWhatsNew();
    if (w.items.length) await chrome.storage.local.set({ whatsNew: { ...w, from: previousVersion, seen: false, pageShown: false } });
  }
  await showBadge();
  checkUpdate(true).catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => checkUpdate().catch(() => {}));
checkUpdate().catch(() => {});

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
  if (msg?.cmd === "shareOpen") {
    // 2.3 Invite: open an app's own start page next to the tab (fixed addresses only; the invite link is on the
    // clipboard, never in the address, so its key isn't sent to the app's servers)
    const url = typeof msg.app === "string" && Object.hasOwn(SHARE_APPS, msg.app) ? SHARE_APPS[msg.app] : null;
    if (!url || !sender.tab) return sendResponse({ error: "unknown app" });
    chrome.tabs.create({ url, index: sender.tab.index + 1, openerTabId: sender.tab.id }).then(() => sendResponse({ ok: true }), () => sendResponse({ error: "tab" }));
    return true;
  }
  if (msg?.cmd === "shareQr") {
    // 2.3, from the tab's content script: show its invite link as a QR code in our own window (op "show"), or
    // close it and forget the link (op "close", when the party ends there)
    if (!sender.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0) return sendResponse({ error: "no tab" });
    if (msg.op === "close") {
      qrClose(sender.tab.id).then(() => sendResponse({ ok: true }), () => sendResponse({ error: "storage" }));
      return true;
    }
    const link = cleanInvite(msg.link);
    if (!link) return sendResponse({ error: "bad link" });
    qrOpen(sender.tab.id, link).then(() => sendResponse({ ok: true }), () => sendResponse({ error: "window" }));
    return true;
  }
  if (msg?.cmd === "qrLink") {
    // qr.html only (our own page, never a content script): the link it should draw
    if (!String(sender.url || "").startsWith(chrome.runtime.getURL("qr.html")) || !Number.isInteger(msg.tab)) return sendResponse({ error: "not allowed" });
    const k = qrKey(msg.tab);
    chrome.storage.session.get(k).then((r) => sendResponse({ link: r[k]?.link || null }), () => sendResponse({ error: "storage" }));
    return true;
  }
  if (msg?.cmd === "recap") {
    // content scripts only: a tab's recap belongs to that tab
    if (!sender.tab || !Number.isInteger(sender.tab.id)) return sendResponse({ error: "no tab" });
    recapStore(msg, sender.tab.id).then(sendResponse, () => sendResponse({ error: "storage" }));
    return true;
  }
  if (msg?.cmd === "updateInfo") {
    // 2.4: is there a newer version, and the What's new of the one just installed (popup and content scripts)
    updateInfo().then(sendResponse, () => sendResponse({ version: myVersion(), update: null, whatsNew: null }));
    return true;
  }
  if (msg?.cmd === "updateNow") {
    updateNow().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  if (msg?.cmd === "updateLater") {
    // the page's reminder was closed: the next one waits a day
    chrome.storage.local.set({ updateNagAt: Date.now() }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.cmd === "whatsNewSeen") {
    // the popup showed it (done), or a page showed its short version (the popup still shows it once)
    (async () => {
      const { whatsNew } = await chrome.storage.local.get("whatsNew");
      if (!whatsNew) return;
      if (msg.where === "page") whatsNew.pageShown = true;
      else whatsNew.seen = true;
      await chrome.storage.local.set({ whatsNew });
      await showBadge();
    })().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
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
