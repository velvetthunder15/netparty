// NetParty room logic, transport-agnostic. Used by the Node server (server.js)
// and the Cloudflare Worker (worker/). Protocol: JSON frames { type, reqId?, data? }.
const ROOM_TTL_MS = 10 * 60 * 1000; // keep an empty room this long
const MAX_CHAT = 500;
const MAX_MEMBERS = 50;
const HISTORY = 150; // chat + system lines replayed to anyone who (re)joins
const GRACE_MS = 15_000;
const RESTORE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // a saved party older than this is not brought back
const REACT_MAX = 6; // reactions per connection…
const REACT_WINDOW_MS = 3000; // …per this window

// ---- shared validators (also used by the GIF proxy in gifs.js)
// Profile pictures are emoji. The picker offers these; any other single emoji
// (one grapheme, at most 8 UTF-16 units) is accepted too, nothing else is.
export const AVATARS = [
  "🐶", "🐱", "🐼", "🦊", "🐨", "🐸", "🐵", "🐧", "🦄", "🐯", "🐰", "🐻", "🐮", "🐷", "🐙", "🦁",
  "🍕", "🍩", "🍔", "🌮", "🍣", "🧁", "🍉", "🍓", "🍪", "🥑", "🍦", "🍿",
];
const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
export function isSingleEmoji(s, maxUnits = 16) {
  if (typeof s !== "string" || !s || s.length > maxUnits) return false;
  // must be a picture (or a flag), with no letters, digits, spaces or markup in it
  if (!/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(s)) return false;
  if (/[\p{L}\p{N}\p{P}\p{Z}\p{Cc}<>`$^|~=+]/u.test(s)) return false;
  if (segmenter) {
    let n = 0;
    for (const _ of segmenter.segment(s)) if (++n > 1) return false;
  }
  return true;
}
export const cleanAvatar = (a) => (AVATARS.includes(a) || isSingleEmoji(a, 8) ? a : null);
// GIFs in chat may only come from KLIPY's media servers (docs.klipy.com/network-requirements)
export const KLIPY_MEDIA_HOSTS = ["static.klipy.com", "static1.klipy.com", "static2.klipy.com"];
export function isKlipyMediaUrl(s) {
  if (typeof s !== "string" || s.length > 600) return false;
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return u.protocol === "https:" && !u.username && !u.password && !u.port && KLIPY_MEDIA_HOSTS.includes(u.hostname) && u.href === s;
}
function cleanGif(g) {
  if (!g || typeof g !== "object" || !isKlipyMediaUrl(g.url)) return null;
  const dim = (n) => (Number.isInteger(n) && n > 0 && n <= 4096 ? n : null);
  return { url: g.url, w: dim(g.w), h: dim(g.h) };
}

export function defaultIceServers(env = {}) {
  const ice = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  if (env.TURN_URL) ice.push({ urls: env.TURN_URL.split(","), username: env.TURN_USER, credential: env.TURN_PASS });
  return ice;
}

// store (optional): { get(id) -> Promise<obj|null>, put(id, obj), del(id) }. With one, a party
// survives a server restart: its playback state, host and chat come back on the next join.
export function createHub({ iceServers = defaultIceServers(), store = null } = {}) {
const ICE_SERVERS = iceServers;
const newId = (n = 8) => {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const b of bytes) s += abc[b % abc.length];
  return s;
};
/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {{ id: string, members: Map<string, Client>, state: PlayState,
 *   hostId: string, hostOnly: boolean, emptySince: number|null }} Room
 * @typedef {{ playing: boolean, position: number, at: number, videoId: string|null, by: string|null }} PlayState
 * @typedef {{ id: string, send: (s: string) => void, name: string, roomId: string|null, inVoice?: boolean }} Client
 */


function send(client, msg) {
  try {
    client.send(JSON.stringify(msg));
  } catch {}
}

function broadcast(room, msg, exceptId = null) {
  for (const m of room.members.values()) if (m.id !== exceptId) send(m, msg);
}

function memberList(room) {
  return [...room.members.values()].map((m) => ({ id: m.id, name: m.name, avatar: m.avatar || null, host: m.id === room.hostId, inVoice: !!m.inVoice }));
}

function snapshot(room) {
  return {
    roomId: room.id,
    hostId: room.hostId,
    hostOnly: room.hostOnly,
    state: room.state,
    members: memberList(room),
    history: room.history,
  };
}

function remember(room, entry) {
  room.history.push(entry);
  if (room.history.length > HISTORY) room.history.splice(0, room.history.length - HISTORY);
  save(room);
}

// ---- persistence (debounced; failures only cost restart-survival, never the live party)
function save(room) {
  if (!store || room.ended || room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    if (room.ended) return;
    const { id, state, hostOnly, hostCid, history } = room;
    Promise.resolve(store.put(id, { id, state, hostOnly, hostCid, history, savedAt: Date.now() })).catch(() => {});
  }, 300);
}
function forget(id) {
  if (store) Promise.resolve(store.del(id)).catch(() => {});
}
const restoring = new Map();
async function findRoom(code) {
  const id = String(code || "").toLowerCase();
  if (!/^[a-z0-9]{4,16}$/.test(id)) return null;
  if (rooms.has(id) || !store) return rooms.get(id) || null;
  if (!restoring.has(id)) {
    restoring.set(
      id,
      (async () => {
        try {
          const saved = await store.get(id);
          if (rooms.has(id)) return rooms.get(id);
          if (!saved || Date.now() - (saved.savedAt || 0) > RESTORE_MAX_AGE_MS) return null;
          const room = {
            id,
            members: new Map(),
            hostId: null,
            hostOnly: !!saved.hostOnly,
            hostCid: saved.hostCid || null,
            history: Array.isArray(saved.history) ? saved.history.slice(-HISTORY) : [],
            emptySince: Date.now(),
            state: saved.state,
          };
          rooms.set(id, room);
          return room;
        } catch {
          return null;
        } finally {
          restoring.delete(id);
        }
      })(),
    );
  }
  return restoring.get(id);
}
function systemLine(room, text, exceptId = null) {
  const data = { text, ts: Date.now() };
  remember(room, { kind: "system", ...data });
  broadcast(room, { type: "system", data }, exceptId);
}
const membersMsg = (room) => ({ type: "members", data: { members: memberList(room), hostId: room.hostId } });

function cleanName(s) {
  return String(s || "Guest").replace(/\s+/g, " ").trim().slice(0, 24) || "Guest";
}

function validState(d) {
  return (
    d &&
    typeof d.playing === "boolean" &&
    Number.isFinite(d.position) &&
    d.position >= 0 &&
    (d.at === undefined || Number.isFinite(d.at))
  );
}

function leaveRoom(client, { silent = false } = {}) {
  const room = client.roomId && rooms.get(client.roomId);
  client.roomId = null;
  clearTimeout(client.graceTimer);
  if (!room || room.members.get(client.id) !== client) return;
  if (client.inVoice) broadcast(room, { type: "voice", data: { event: "leave", id: client.id } }, client.id);
  client.inVoice = false;
  room.members.delete(client.id);
  if (room.members.size === 0) {
    room.emptySince = Date.now();
    return;
  }
  if (room.hostId === client.id) room.hostId = [...room.members.values()].find((m) => !m.away)?.id || room.members.keys().next().value;
  broadcast(room, membersMsg(room));
  if (!silent) systemLine(room, `${client.name} left`);
}

// Same browser tab coming back (page reload, episode change, network blip): it
// takes over its old seat silently and keeps the host role.
function joinRoom(client, room) {
  if (client.roomId) leaveRoom(client);
  const old = client.cid ? [...room.members.values()].find((m) => m.cid === client.cid && m !== client) : null;
  let returning = false;
  if (old) {
    returning = true;
    clearTimeout(old.graceTimer);
    if (old.inVoice) broadcast(room, { type: "voice", data: { event: "leave", id: old.id } }, old.id);
    room.members.delete(old.id);
    old.roomId = null;
    if (room.hostId === old.id) room.hostId = client.id;
  }
  room.members.set(client.id, client);
  room.emptySince = null;
  client.roomId = room.id;
  if (!room.members.has(room.hostId)) room.hostId = client.id;
  if (room.hostCid && room.hostCid === client.cid) room.hostId = client.id; // host came back after a long drop
  broadcast(room, membersMsg(room), client.id);
  if (!returning) systemLine(room, `${client.name} joined`, client.id);
  return returning;
}

const cleanCid = (s) => (typeof s === "string" && /^[a-z0-9]{8,32}$/i.test(s) ? s : null);

const handlers = {
  time(client, _data, reply) {
    reply({ serverTime: Date.now() });
  },

  create(client, data, reply) {
    let id;
    do id = newId(8);
    while (rooms.has(id));
    client.name = cleanName(data?.name);
    client.avatar = cleanAvatar(data?.avatar);
    client.cid = cleanCid(data?.cid);
    const now = Date.now();
    /** @type {Room} */
    const room = {
      id,
      members: new Map(),
      hostId: client.id,
      hostOnly: !!data?.hostOnly,
      hostCid: client.cid,
      history: [],
      emptySince: null,
      state: {
        playing: !!data?.playing,
        position: Number.isFinite(data?.position) ? data.position : 0,
        at: Number.isFinite(data?.at) ? data.at : now,
        videoId: data?.videoId ? String(data.videoId) : null,
        by: client.id,
      },
    };
    rooms.set(id, room);
    joinRoom(client, room);
    save(room);
    reply(snapshot(room));
  },

  async join(client, data, reply) {
    const room = await findRoom(data?.roomId);
    if (!room) return reply(null, "Party not found. It may have ended.");
    if (room.members.size >= MAX_MEMBERS) return reply(null, "Party is full.");
    client.name = cleanName(data?.name);
    client.avatar = cleanAvatar(data?.avatar);
    client.cid = cleanCid(data?.cid);
    const returning = joinRoom(client, room);
    reply({ ...snapshot(room), returning });
  },

  // which title a party is on, without joining it (so a guest can be sent there first)
  async peek(_client, data, reply) {
    const room = await findRoom(data?.roomId);
    if (!room || room.ended) return reply(null, "Party not found. It may have ended.");
    reply({ roomId: room.id, videoId: room.state.videoId, members: room.members.size });
  },

  leave(client, _data, reply) {
    leaveRoom(client);
    reply({ ok: true });
  },

  // host closes the party for everyone (e.g. they left the movie)
  end(client, _data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    if (!room) return reply({ ok: true });
    if (client.id !== room.hostId) return reply(null, "Only the host can end the party.");
    room.ended = true;
    clearTimeout(room.saveTimer);
    broadcast(room, { type: "ended", data: { byName: client.name } }, client.id);
    for (const m of room.members.values()) {
      clearTimeout(m.graceTimer);
      m.roomId = null;
      m.inVoice = false;
    }
    room.members.clear();
    rooms.delete(room.id);
    forget(room.id);
    reply({ ok: true });
  },

  state(client, data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    if (!room) return reply(null, "Not in a party.");
    if (room.hostOnly && client.id !== room.hostId) return reply(null, "Only the host can control playback.");
    if (!validState(data)) return reply(null, "Bad state.");
    room.state = {
      playing: data.playing,
      position: data.position,
      // client stamps "at" in server time (it knows its clock offset); fall back to now
      at: Number.isFinite(data.at) && Math.abs(data.at - Date.now()) < 10_000 ? data.at : Date.now(),
      videoId: data.videoId ? String(data.videoId) : room.state.videoId,
      by: client.id,
    };
    save(room);
    broadcast(room, { type: "state", data: { ...room.state, byName: client.name, reason: data.reason || null } }, client.id);
    reply({ ok: true });
  },

  // text message, or a GIF ({ gif: { url, w, h } }, url on KLIPY's media hosts only).
  // GIF lines also carry text "GIF" so 1.5 clients show something sensible.
  chat(client, data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    if (!room) return reply(null, "Not in a party.");
    let gif = null;
    if (data?.gif !== undefined) {
      gif = cleanGif(data.gif);
      if (!gif) return reply(null, "Bad GIF.");
    }
    const text = gif ? "GIF" : String(data?.text || "").trim().slice(0, MAX_CHAT);
    if (!text) return reply(null, "Empty message.");
    const line = { id: client.id, cid: client.cid, name: client.name, avatar: client.avatar || null, text, ts: Date.now() };
    if (gif) line.gif = gif;
    remember(room, { kind: "chat", ...line });
    broadcast(room, { type: "chat", data: line });
    reply({ ok: true });
  },

  rename(client, data, reply) {
    client.name = cleanName(data?.name);
    const room = client.roomId && rooms.get(client.roomId);
    if (room) broadcast(room, { type: "members", data: { members: memberList(room), hostId: room.hostId } });
    reply({ ok: true });
  },

  // change your profile picture (an emoji) mid-party
  avatar(client, data, reply) {
    const avatar = cleanAvatar(data?.avatar);
    if (!avatar) return reply(null, "Bad avatar.");
    client.avatar = avatar;
    const room = client.roomId && rooms.get(client.roomId);
    if (room) broadcast(room, membersMsg(room));
    reply({ ok: true });
  },

  // floating emoji reaction over everyone's video (not kept in history)
  react(client, data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    if (!room) return reply(null, "Not in a party.");
    const emoji = data?.emoji;
    if (!isSingleEmoji(emoji, 16)) return reply(null, "Bad reaction.");
    const now = Date.now();
    client.reacts = (client.reacts || []).filter((t) => now - t < REACT_WINDOW_MS);
    if (client.reacts.length >= REACT_MAX) return reply(null, "Slow down.");
    client.reacts.push(now);
    broadcast(room, { type: "react", data: { id: client.id, name: client.name, avatar: client.avatar || null, emoji, ts: now } }, client.id);
    reply({ ok: true });
  },

  settings(client, data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    if (!room) return reply(null, "Not in a party.");
    if (client.id !== room.hostId) return reply(null, "Only the host can change settings.");
    room.hostOnly = !!data?.hostOnly;
    save(room);
    broadcast(room, { type: "settings", data: { hostOnly: room.hostOnly } });
    reply({ ok: true });
  },

  // ---- Voice chat (WebRTC mesh). Server only tracks who is in voice and relays signaling.
  voiceJoin(client, _data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    if (!room) return reply(null, "Not in a party.");
    const peers = [...room.members.values()].filter((m) => m.inVoice && m.id !== client.id).map((m) => m.id);
    client.inVoice = true;
    broadcast(room, { type: "voice", data: { event: "join", id: client.id, name: client.name } }, client.id);
    broadcast(room, { type: "members", data: { members: memberList(room), hostId: room.hostId } });
    reply({ peers, iceServers: ICE_SERVERS });
  },

  voiceLeave(client, _data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    const was = client.inVoice;
    client.inVoice = false;
    if (was && room) {
      broadcast(room, { type: "voice", data: { event: "leave", id: client.id } }, client.id);
      broadcast(room, { type: "members", data: { members: memberList(room), hostId: room.hostId } });
    }
    reply({ ok: true });
  },

  voiceState(client, data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    if (!room || !client.inVoice) return reply(null, "Not in voice.");
    broadcast(room, { type: "voice", data: { event: "state", id: client.id, muted: !!data?.muted, speaking: !!data?.speaking } }, client.id);
    reply({ ok: true });
  },

  signal(client, data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    const target = room && room.members.get(String(data?.to || ""));
    if (!target) return reply(null, "Peer not found.");
    send(target, { type: "signal", data: { from: client.id, payload: data.payload } });
    reply({ ok: true });
  },

  ping(_client, _data, reply) {
    reply({ pong: true });
  },
};


function connect(sendRaw) {
  /** @type {Client} */
  const client = { id: newId(10), send: sendRaw, name: "Guest", roomId: null, inVoice: false };
  send(client, { type: "welcome", data: { userId: client.id, serverTime: Date.now() } });
  return {
    id: client.id,
    message(raw) {
      let msg;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        return;
      }
      if (typeof raw === "string" ? raw.length > 65536 : raw.byteLength > 65536) return;
      const fn = handlers[msg?.type];
      const reply = (data, error) =>
        msg.reqId !== undefined && send(client, { type: "reply", reqId: msg.reqId, data, error: error || null });
      if (!fn) return reply(null, "Unknown type.");
      try {
        const r = fn(client, msg.data, reply);
        if (r && typeof r.catch === "function")
          r.catch((e) => {
            console.error(e);
            reply(null, "Server error.");
          });
      } catch (e) {
        console.error(e);
        reply(null, "Server error.");
      }
    },
    close() {
      // keep the seat briefly so a reload doesn't spam "left/joined" or drop the host
      const room = client.roomId && rooms.get(client.roomId);
      if (!room || !client.cid) return leaveRoom(client);
      client.away = true;
      client.send = () => {};
      if (client.inVoice) {
        client.inVoice = false;
        broadcast(room, { type: "voice", data: { event: "leave", id: client.id } }, client.id);
        broadcast(room, membersMsg(room));
      }
      client.graceTimer = setTimeout(() => {
        if (client.roomId) leaveRoom(client);
        if (room.members.size === 0) room.emptySince = Date.now();
      }, GRACE_MS);
    },
  };
}

function sweep() {
  const now = Date.now();
  for (const [id, room] of rooms)
    if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) {
      rooms.delete(id);
      forget(id);
    }
}

return { connect, sweep, rooms, getRoom: (code) => rooms.get(String(code || "").toLowerCase()), findRoom };
}

// ---------------------------------------------------------------- invite page
// GET /j/<code> on the party server. Friends land here from an invite link: it sends
// them to the right title (where the extension auto-joins), or tells them how to
// install NetParty first. The extension download only works while the party is live.
export function watchUrlFor(videoId, roomId) {
  if (!videoId) return null;
  if (videoId.startsWith("yt:"))
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId.slice(3))}&npParty=${encodeURIComponent(roomId)}`;
  const base = videoId.startsWith("hs:")
    ? "https://www.hotstar.com" + videoId.slice(3)
    : "https://www.netflix.com/watch/" + encodeURIComponent(videoId);
  return `${base}?npParty=${encodeURIComponent(roomId)}`;
}
export const siteFor = (videoId) =>
  String(videoId || "").startsWith("hs:") ? "JioHotstar" : String(videoId || "").startsWith("yt:") ? "YouTube" : "Netflix";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function joinPage(room, code, { hasDownload = false } = {}) {
  const live = !!room && !room.ended;
  const host = live ? [...room.members.values()].find((m) => m.id === room.hostId) || [...room.members.values()][0] : null;
  const site = siteFor(room?.state.videoId);
  const watch = live ? watchUrlFor(room.state.videoId, room.id) : null;
  const body = !live
    ? `<h1>This party has ended</h1><p>Ask your friend for a fresh invite link.</p>`
    : `<h1>${esc(host?.name || "A friend")} invited you to a watch party</h1>
<p class="sub">${room.members.size ? room.members.size + " watching" : "Live"} on ${site} · party <code>${esc(room.id)}</code></p>
<a class="btn" href="${esc(watch)}">Join on ${site}</a>
<p class="note">${site === "YouTube" ? "You need" : `You need your own ${site} account and`} the NetParty extension in Chrome (or Edge, Brave).</p>
<details${hasDownload ? "" : " open"}><summary>Don't have NetParty yet?</summary>
<ol>
${hasDownload ? `<li><a href="/j/${esc(room.id)}/netparty.zip">Download NetParty</a> and unzip it.</li>` : `<li>Ask ${esc(host?.name || "your friend")} to send you the NetParty zip, then unzip it.</li>`}
<li>Open <code>chrome://extensions</code> and switch on <b>Developer mode</b> (top right).</li>
<li>Click <b>Load unpacked</b> and pick the unzipped folder (the one with <code>manifest.json</code> inside).</li>
<li>Come back here and press <b>Join on ${site}</b>.</li>
</ol></details>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NetParty invite</title><meta name="robots" content="noindex">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121216;color:#f3f3f6;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:460px;padding:32px 24px}
.logo{font-weight:800;color:#a48bff;letter-spacing:.02em;margin-bottom:18px}
h1{font-size:24px;line-height:1.25;margin:0 0 8px}.sub{color:#9d9da8;margin:0 0 22px}
.btn{display:block;text-align:center;padding:14px;border-radius:12px;background:#7c5cff;color:#fff;font-weight:700;text-decoration:none}
.btn:hover{background:#a48bff}.note{color:#9d9da8;font-size:14px}
details{margin-top:18px;padding:14px 16px;border:1px solid #33333c;border-radius:12px;background:#1b1b22}
summary{cursor:pointer;font-weight:600}ol{padding-left:20px;margin:10px 0 0}li{margin:6px 0}
a{color:#a48bff}code{background:#26262e;padding:1px 6px;border-radius:6px;font-size:14px}
</style></head><body><main><div class="logo">NetParty</div>${body}</main></body></html>`;
}
