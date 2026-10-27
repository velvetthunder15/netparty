// NetParty room logic, transport-agnostic. Used by the Node server (server.js)
// and the Cloudflare Worker (worker/). Protocol: JSON frames { type, reqId?, data? }.
//
// End-to-end encryption (1.7): chat messages, GIFs, reactions, names, profile pictures and
// voice-call setup (SDP/ICE) are encrypted in the browser with a room key that lives only in
// the invite link's #fragment and in the participants' browsers. This server only ever sees,
// stores and relays opaque ciphertext ("ct", base64url) next to public member ids ("pid").
// It checks shape and size, rate-limits, and never needs (or gets) the key.
//
// Identifiers: each browser tab sends a private reconnect secret ("cid", 128-bit random hex)
// with create/join. It never leaves this server. Everyone else only ever sees the member's
// public id ("pid"), which the server picks at random and keeps for that tab's seat.
const ROOM_TTL_MS = 10 * 60 * 1000; // keep an empty room this long
const MAX_CHAT = 500; // characters of chat text (enforced by the clients after decryption)
const MAX_NAME = 24;
const MAX_MEMBERS = 50;
const HISTORY = 150; // chat + join/leave lines replayed to anyone who (re)joins
const GRACE_MS = 15_000;
const RESTORE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // a saved party older than this is not brought back
export const PURGE_AGE_MS = RESTORE_MAX_AGE_MS - 15 * 60 * 1000; // saved parties idle this long are deleted (sweeps run every 15 min)
const MAX_SEATS = 200;
const limits = {
  react: [12, 3000], // reactions per connection per window (tapping 🎉 repeatedly sends several)
  chat: [20, 10_000],
  profile: [10, 10_000],
};

// ---- ciphertext sizes. Wire format (built by the extension): base64url(0x01 | 12-byte IV |
// AES-GCM ciphertext + 16-byte tag); the plaintext is JSON padded with spaces to a multiple of 64 bytes.
const ctChars = (plainBytes) => Math.ceil(((1 + 12 + 16 + plainBytes) * 4) / 3);
const pad64 = (n) => Math.ceil(n / 64) * 64;
// worst case JSON: every UTF-16 unit escaped as \uXXXX (6 bytes), plus the field names
export const MAX_CHAT_CT = ctChars(pad64(MAX_CHAT * 6 + 64)); // text, or a GIF (url ≤ 600 + size)
export const MAX_PROFILE_CT = ctChars(pad64(MAX_NAME * 2 * 6 + 16 * 6 + 64)); // { name, avatar }
export const MAX_REACT_CT = ctChars(pad64(16 * 6 + 32)); // { e: one emoji }
export const MAX_CHECK_CT = ctChars(128); // the room's key-check value
export const MAX_SIGNAL_CT = 32_768; // WebRTC offer/answer or ICE candidate
const MIN_CT = ctChars(1);
const isCt = (s, max) => typeof s === "string" && s.length >= MIN_CT && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s);

export const NEED_UPDATE =
  "Update NetParty to version 1.7 or newer: party chat is now end-to-end encrypted, and this version can't start or join parties. Get it at netparty.tech.";
export const LEGACY_ROOM =
  "This party was started with an older NetParty that doesn't encrypt chat. Ask the host to update NetParty and start a new party.";
const PLAYBACK_REASONS = new Set(["play", "pause", "seeked", "episode"]);

// ---- shared validators (also used by the GIF proxy in gifs.js; the extension has copies
// and applies them to decrypted content)
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

export function defaultIceServers(env = {}) {
  const ice = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  if (env.TURN_URL) ice.push({ urls: env.TURN_URL.split(","), username: env.TURN_USER, credential: env.TURN_PASS });
  return ice;
}

// private per-tab reconnect secret: 128 random bits as hex (the extension makes 32 hex chars)
const cleanCid = (s) => (typeof s === "string" && /^[0-9a-f]{32,64}$/.test(s) ? s : null);
const announcesE2ee = (data) => data?.e2ee === 1 || data?.e2ee === true;

// store (optional): { get(id) -> Promise<obj|null>, put(id, obj), del(id), list?() -> Promise<[id, obj][]> }.
// With one, a party survives a server restart: its playback state, host, seats and (encrypted)
// chat come back on the next join.
export function createHub({ iceServers = defaultIceServers(), store = null } = {}) {
const ICE_SERVERS = iceServers;
const newId = (n = 8) => {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  while (s.length < n) {
    // rejection sampling: no modulo bias
    for (const b of crypto.getRandomValues(new Uint8Array(n))) if (b < 252 && s.length < n) s += abc[b % 36];
  }
  return s;
};
/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {{ id: string, e2ee: true, members: Map<string, Client>, state: PlayState, hostId: string|null,
 *   hostCid: string|null, hostOnly: boolean, history: object[], profiles: Map<string,string>,
 *   seats: Map<string,string>, kc: string, emptySince: number|null, ended?: boolean }} Room
 * @typedef {{ playing: boolean, position: number, at: number, videoId: string|null, by: string|null }} PlayState
 * @typedef {{ pid: string|null, cid: string|null, send: (s: string) => void, roomId: string|null, inVoice?: boolean }} Client
 */

function send(client, msg) {
  try {
    client.send(JSON.stringify(msg));
  } catch {}
}

function broadcast(room, msg, exceptPid = null) {
  for (const m of room.members.values()) if (m.pid !== exceptPid) send(m, msg);
}

// Everything another member can learn about a member: public id, host flag, voice flag and
// the encrypted profile blob. Never the cid.
function memberList(room) {
  return [...room.members.values()].map((m) => ({
    id: m.pid,
    host: m.pid === room.hostId,
    inVoice: !!m.inVoice,
    profile: room.profiles.get(m.pid) || null,
  }));
}

// encrypted profiles of everyone a joiner may need to name: members and authors in the history
function knownProfiles(room) {
  const want = new Set(room.members.keys());
  for (const h of room.history) want.add(h.kind === "chat" ? h.from : h.id);
  const out = {};
  for (const pid of want) if (room.profiles.has(pid)) out[pid] = room.profiles.get(pid);
  return out;
}

function snapshot(room, client) {
  return {
    e2ee: true,
    roomId: room.id,
    you: client.pid,
    hostId: room.hostId,
    hostOnly: room.hostOnly,
    state: room.state,
    kc: room.kc,
    members: memberList(room),
    profiles: knownProfiles(room),
    history: room.history,
  };
}

function remember(room, entry) {
  room.history.push(entry);
  if (room.history.length > HISTORY) room.history.splice(0, room.history.length - HISTORY);
  save(room);
}

// ---- persistence (debounced; failures only cost restart-survival, never the live party).
// What is stored: room code, playback state, settings, the encrypted key check, seats
// (cid -> pid, server-side only), encrypted profiles and the encrypted history.
function prune(room) {
  // profiles nobody can need any more (not a member, not in the history)
  const keep = new Set(room.members.keys());
  for (const h of room.history) keep.add(h.kind === "chat" ? h.from : h.id);
  for (const pid of room.profiles.keys()) if (!keep.has(pid)) room.profiles.delete(pid);
  if (room.seats.size > MAX_SEATS) {
    const active = new Set(room.members.keys());
    for (const [cid, pid] of room.seats) {
      if (room.seats.size <= MAX_SEATS) break;
      if (!active.has(pid) && cid !== room.hostCid) room.seats.delete(cid);
    }
  }
}
function save(room) {
  if (!store || room.ended || room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    if (room.ended) return;
    prune(room);
    const { id, state, hostOnly, hostCid, history, kc } = room;
    const rec = { id, e2ee: true, state, hostOnly, hostCid, kc, history, profiles: [...room.profiles], seats: [...room.seats], savedAt: Date.now() };
    Promise.resolve(store.put(id, rec)).catch(() => {});
  }, 300);
}
function forget(id) {
  if (store) Promise.resolve(store.del(id)).catch(() => {});
}
const LEGACY = Object.freeze({ legacy: true });
const restoring = new Map();
// -> Room, LEGACY (a saved party from before 1.7, which nobody can use any more), or null
async function lookup(code) {
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
          if (!saved) return null;
          if (!saved.e2ee) {
            forget(id); // pre-1.7 plaintext party: delete it
            return LEGACY;
          }
          if (Date.now() - (saved.savedAt || 0) > RESTORE_MAX_AGE_MS) {
            forget(id);
            return null;
          }
          const room = {
            id,
            e2ee: true,
            members: new Map(),
            hostId: null,
            hostOnly: !!saved.hostOnly,
            hostCid: cleanCid(saved.hostCid),
            kc: isCt(saved.kc, MAX_CHECK_CT) ? saved.kc : null,
            history: Array.isArray(saved.history) ? saved.history.slice(-HISTORY) : [],
            profiles: new Map(Array.isArray(saved.profiles) ? saved.profiles : []),
            seats: new Map(Array.isArray(saved.seats) ? saved.seats : []),
            emptySince: Date.now(),
            state: saved.state,
          };
          if (!room.kc) return null;
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
async function findRoom(code) {
  const r = await lookup(code);
  return r && !r.legacy ? r : null;
}

// "<name> joined/left": the server doesn't know names, so it records who (pid) and what,
// and each client renders the line from that member's decrypted profile.
function systemLine(room, event, pid, exceptPid = null) {
  const data = { event, id: pid, ts: Date.now() };
  remember(room, { kind: "system", ...data });
  broadcast(room, { type: "system", data }, exceptPid);
}
const membersMsg = (room) => ({ type: "members", data: { members: memberList(room), hostId: room.hostId } });

function validState(d) {
  return (
    d &&
    typeof d.playing === "boolean" &&
    Number.isFinite(d.position) &&
    d.position >= 0 &&
    (d.at === undefined || Number.isFinite(d.at)) &&
    (d.videoId === undefined || d.videoId === null || (typeof d.videoId === "string" && d.videoId.length <= 512))
  );
}
const cleanVideoId = (v) => (typeof v === "string" && v && v.length <= 512 ? v : null);

function limited(client, kind) {
  const [max, windowMs] = limits[kind];
  const now = Date.now();
  const list = (client.hits[kind] = (client.hits[kind] || []).filter((t) => now - t < windowMs));
  if (list.length >= max) return true;
  list.push(now);
  return false;
}

function leaveRoom(client, { silent = false } = {}) {
  const room = client.roomId && rooms.get(client.roomId);
  client.roomId = null;
  clearTimeout(client.graceTimer);
  if (!room || room.members.get(client.pid) !== client) return;
  if (client.inVoice) broadcast(room, { type: "voice", data: { event: "leave", id: client.pid } }, client.pid);
  client.inVoice = false;
  room.members.delete(client.pid);
  if (room.members.size === 0) {
    room.emptySince = Date.now();
    return;
  }
  if (room.hostId === client.pid) room.hostId = [...room.members.values()].find((m) => !m.away)?.pid || room.members.keys().next().value;
  broadcast(room, membersMsg(room));
  if (!silent) systemLine(room, "leave", client.pid);
}

// A tab's seat is found by its private cid: the same tab coming back (page reload, episode
// change, network blip, server restart) gets the same public pid, keeps the host role and
// takes over silently. A cid nobody has used gets a new seat. Knowing someone's pid gets you nothing.
function joinRoom(client, room) {
  if (client.roomId) leaveRoom(client);
  let pid = room.seats.get(client.cid);
  if (!pid) {
    const used = new Set([...room.seats.values(), ...room.profiles.keys(), ...room.members.keys()]);
    do pid = newId(12);
    while (used.has(pid));
    room.seats.set(client.cid, pid);
  }
  const old = room.members.get(pid);
  let returning = false;
  if (old && old !== client) {
    returning = true;
    clearTimeout(old.graceTimer);
    if (old.inVoice) broadcast(room, { type: "voice", data: { event: "leave", id: pid } }, pid);
    old.roomId = null;
    old.inVoice = false;
  }
  client.pid = pid;
  client.away = false;
  room.members.set(pid, client);
  room.emptySince = null;
  client.roomId = room.id;
  if (!room.members.has(room.hostId)) room.hostId = pid;
  if (room.hostCid && room.hostCid === client.cid) room.hostId = pid; // host came back after a long drop
  broadcast(room, membersMsg(room), pid);
  if (!returning) systemLine(room, "join", pid, pid);
  else save(room);
  return returning;
}

const inRoom = (client) => (client.roomId && rooms.get(client.roomId)) || null;

const handlers = {
  time(client, _data, reply) {
    reply({ serverTime: Date.now() });
  },

  // data: { e2ee: 1, cid, kc (encrypted key check), videoId, playing, position, at }
  create(client, data, reply) {
    if (!announcesE2ee(data)) return reply(null, NEED_UPDATE);
    const cid = cleanCid(data?.cid);
    if (!cid) return reply(null, "Bad client id.");
    if (!isCt(data?.kc, MAX_CHECK_CT)) return reply(null, "Bad key check.");
    let id;
    do id = newId(8);
    while (rooms.has(id));
    client.cid = cid;
    const now = Date.now();
    /** @type {Room} */
    const room = {
      id,
      e2ee: true,
      members: new Map(),
      hostId: null,
      hostOnly: !!data?.hostOnly,
      hostCid: cid,
      kc: data.kc,
      history: [],
      profiles: new Map(),
      seats: new Map(),
      emptySince: null,
      state: {
        playing: !!data?.playing,
        position: Number.isFinite(data?.position) && data.position >= 0 ? data.position : 0,
        at: Number.isFinite(data?.at) ? data.at : now,
        videoId: cleanVideoId(data?.videoId),
        by: null,
      },
    };
    rooms.set(id, room);
    joinRoom(client, room);
    room.state.by = client.pid;
    save(room);
    reply(snapshot(room, client));
  },

  // data: { e2ee: 1, roomId, cid }
  async join(client, data, reply) {
    if (!announcesE2ee(data)) return reply(null, NEED_UPDATE);
    const cid = cleanCid(data?.cid);
    if (!cid) return reply(null, "Bad client id.");
    const room = await lookup(data?.roomId);
    if (room?.legacy) return reply(null, LEGACY_ROOM);
    if (!room || room.ended) return reply(null, "Party not found. It may have ended.");
    // asked again on the same connection (e.g. to refresh the history): nothing changes
    if (client.roomId === room.id && client.cid === cid && room.members.get(client.pid) === client)
      return reply({ ...snapshot(room, client), returning: true });
    if (room.members.size >= MAX_MEMBERS && !room.members.has(room.seats.get(cid))) return reply(null, "Party is full.");
    client.cid = cid;
    const returning = joinRoom(client, room);
    reply({ ...snapshot(room, client), returning });
  },

  // which title a party is on, without joining it (so a guest can be sent there first),
  // plus the key check so the guest's browser can tell whether its invite key is right
  async peek(_client, data, reply) {
    if (!announcesE2ee(data)) return reply(null, NEED_UPDATE);
    const room = await lookup(data?.roomId);
    if (room?.legacy) return reply(null, LEGACY_ROOM);
    if (!room || room.ended) return reply(null, "Party not found. It may have ended.");
    reply({ e2ee: true, roomId: room.id, videoId: room.state.videoId, members: room.members.size, kc: room.kc });
  },

  leave(client, _data, reply) {
    leaveRoom(client);
    reply({ ok: true });
  },

  // host closes the party for everyone (e.g. they left the movie)
  end(client, _data, reply) {
    const room = inRoom(client);
    if (!room) return reply({ ok: true });
    if (client.pid !== room.hostId) return reply(null, "Only the host can end the party.");
    room.ended = true;
    clearTimeout(room.saveTimer);
    broadcast(room, { type: "ended", data: { by: client.pid } }, client.pid);
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
    const room = inRoom(client);
    if (!room) return reply(null, "Not in a party.");
    if (room.hostOnly && client.pid !== room.hostId) return reply(null, "Only the host can control playback.");
    if (!validState(data)) return reply(null, "Bad state.");
    room.state = {
      playing: data.playing,
      position: data.position,
      // client stamps "at" in server time (it knows its clock offset); fall back to now
      at: Number.isFinite(data.at) && Math.abs(data.at - Date.now()) < 10_000 ? data.at : Date.now(),
      videoId: cleanVideoId(data.videoId) || room.state.videoId,
      by: client.pid,
    };
    save(room);
    const reason = PLAYBACK_REASONS.has(data.reason) ? data.reason : null;
    broadcast(room, { type: "state", data: { ...room.state, reason } }, client.pid);
    reply({ ok: true });
  },

  // encrypted chat line (text or GIF): { ct }. Relayed to everyone incl. the sender and kept
  // in the history as ciphertext.
  chat(client, data, reply) {
    const room = inRoom(client);
    if (!room) return reply(null, "Not in a party.");
    if (!isCt(data?.ct, MAX_CHAT_CT)) return reply(null, "Bad message.");
    if (limited(client, "chat")) return reply(null, "Slow down.");
    const line = { from: client.pid, ct: data.ct, ts: Date.now() };
    remember(room, { kind: "chat", ...line });
    broadcast(room, { type: "chat", data: line });
    reply({ ok: true });
  },

  // encrypted { name, avatar }, shown next to this member everywhere
  profile(client, data, reply) {
    const room = inRoom(client);
    if (!room) return reply(null, "Not in a party.");
    if (!isCt(data?.ct, MAX_PROFILE_CT)) return reply(null, "Bad profile.");
    if (limited(client, "profile")) return reply(null, "Slow down.");
    room.profiles.set(client.pid, data.ct);
    save(room);
    broadcast(room, membersMsg(room));
    reply({ ok: true });
  },

  // floating emoji reaction over everyone's video (encrypted; not kept in history)
  react(client, data, reply) {
    const room = inRoom(client);
    if (!room) return reply(null, "Not in a party.");
    if (!isCt(data?.ct, MAX_REACT_CT)) return reply(null, "Bad reaction.");
    if (limited(client, "react")) return reply(null, "Slow down.");
    broadcast(room, { type: "react", data: { from: client.pid, ct: data.ct, ts: Date.now() } }, client.pid);
    reply({ ok: true });
  },

  settings(client, data, reply) {
    const room = inRoom(client);
    if (!room) return reply(null, "Not in a party.");
    if (client.pid !== room.hostId) return reply(null, "Only the host can change settings.");
    room.hostOnly = !!data?.hostOnly;
    save(room);
    broadcast(room, { type: "settings", data: { hostOnly: room.hostOnly } });
    reply({ ok: true });
  },

  // ---- Voice chat (WebRTC mesh). Server only tracks who is in voice and relays the
  // (encrypted) connection setup between two members. Audio goes peer to peer (DTLS-SRTP).
  voiceJoin(client, _data, reply) {
    const room = inRoom(client);
    if (!room) return reply(null, "Not in a party.");
    const peers = [...room.members.values()].filter((m) => m.inVoice && m !== client).map((m) => m.pid);
    client.inVoice = true;
    broadcast(room, { type: "voice", data: { event: "join", id: client.pid } }, client.pid);
    broadcast(room, membersMsg(room));
    reply({ peers, iceServers: ICE_SERVERS });
  },

  voiceLeave(client, _data, reply) {
    const room = inRoom(client);
    const was = client.inVoice;
    client.inVoice = false;
    if (was && room) {
      broadcast(room, { type: "voice", data: { event: "leave", id: client.pid } }, client.pid);
      broadcast(room, membersMsg(room));
    }
    reply({ ok: true });
  },

  voiceState(client, data, reply) {
    const room = inRoom(client);
    if (!room || !client.inVoice) return reply(null, "Not in voice.");
    broadcast(room, { type: "voice", data: { event: "state", id: client.pid, muted: !!data?.muted, speaking: !!data?.speaking } }, client.pid);
    reply({ ok: true });
  },

  // { to: pid, ct: encrypted SDP or ICE candidate }
  signal(client, data, reply) {
    const room = inRoom(client);
    const target = room && room.members.get(String(data?.to || ""));
    if (!target || target === client) return reply(null, "Peer not found.");
    if (!isCt(data?.ct, MAX_SIGNAL_CT)) return reply(null, "Bad signal.");
    send(target, { type: "signal", data: { from: client.pid, ct: data.ct } });
    reply({ ok: true });
  },

  ping(_client, _data, reply) {
    reply({ pong: true });
  },
};

function connect(sendRaw) {
  /** @type {Client} */
  const client = { pid: null, cid: null, send: sendRaw, roomId: null, inVoice: false, hits: {} };
  send(client, { type: "welcome", data: { serverTime: Date.now(), e2ee: true } });
  return {
    message(raw) {
      if (typeof raw === "string" ? raw.length > 65536 : raw.byteLength > 65536) return;
      let msg;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const fn = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
      const reply = (data, error) =>
        msg.reqId !== undefined && send(client, { type: "reply", reqId: msg.reqId, data, error: error || null });
      if (!fn) return reply(null, "Unknown type.");
      // errors are logged by kind only: nothing a client sent ever goes into the logs
      const oops = (e) => {
        console.error("netparty handler error", String(msg.type).slice(0, 20), e?.name || "Error");
        reply(null, "Server error.");
      };
      try {
        const r = fn(client, msg.data, reply);
        if (r && typeof r.catch === "function") r.catch(oops);
      } catch (e) {
        oops(e);
      }
    },
    close() {
      // keep the seat briefly so a reload doesn't spam "left/joined" or drop the host
      const room = inRoom(client);
      if (!room || !client.cid) return leaveRoom(client);
      client.away = true;
      client.send = () => {};
      if (client.inVoice) {
        client.inVoice = false;
        broadcast(room, { type: "voice", data: { event: "leave", id: client.pid } }, client.pid);
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
      clearTimeout(room.saveTimer);
      room.ended = true;
      forget(id);
    }
}

// Saved parties that aren't running and have been idle for PURGE_AGE_MS (or are from before
// 1.7) are deleted; running ones are re-saved so a long, quiet movie stays restorable.
async function maintain() {
  sweep();
  for (const room of rooms.values()) if (room.members.size) save(room);
  if (!store?.list) return;
  const now = Date.now();
  for (const [id, saved] of await store.list()) {
    if (rooms.has(id)) continue;
    if (!saved?.e2ee || !(now - (saved.savedAt || 0) < PURGE_AGE_MS)) await Promise.resolve(store.del(id)).catch(() => {});
  }
}

return { connect, sweep, maintain, rooms, getRoom: (code) => rooms.get(String(code || "").toLowerCase()), findRoom };
}

// ---------------------------------------------------------------- invite page
// GET /j/<code> on the party server. Friends land here from an invite link
// (https://netparty.tech/j/<code>#k=<room key>): the page's own script reads the key from the
// #fragment (which browsers never send to servers), checks it against the party's encrypted key
// check, shows who invited you (decrypted right here) and sends you to the right title with the
// key in that page's #fragment, where the extension picks it up. Nothing is ever fetched or
// sent by this page (its CSP forbids it). It also tells people how to install NetParty first;
// the extension download only works while the party is live.
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

// The invite page's only script. A constant (its SHA-256 is pinned in the page's CSP), so
// everything it needs comes from data- attributes. Must match the extension's crypto format.
const JOIN_SCRIPT = `(async () => {
  const btn = document.getElementById("go"), warn = document.getElementById("warn"), h1 = document.querySelector("h1");
  if (!btn) return;
  // a corrected link pasted into this same tab only changes the #fragment: start over with it
  addEventListener("hashchange", () => location.reload());
  const fail = (t) => { btn.remove(); warn.textContent = t; warn.hidden = false; };
  const m = /^#k=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (!m) return fail("This invite link is incomplete: it's missing the key that unlocks the party's encrypted chat. Ask your friend to copy the full invite link again (the code alone isn't enough).");
  const bytes = (s) => {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  };
  const raw = bytes(m[1]);
  if (raw.length !== 32) return fail("This invite link's key is damaged. Ask your friend to copy the full invite link again.");
  const room = btn.dataset.room, enc = new TextEncoder();
  let key;
  try {
    key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  } catch {
    return fail("This browser can't open encrypted parties. Try an up-to-date Chrome.");
  }
  const open = async (ct, aad) => {
    const b = bytes(ct);
    if (b.length < 29 || b[0] !== 1) throw new Error("format");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(1, 13), additionalData: enc.encode(aad), tagLength: 128 }, key, b.subarray(13));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pt));
  };
  try {
    const kc = await open(btn.dataset.kc, "netparty/e2ee/v1||check|");
    if (!kc || kc.check !== "netparty") throw new Error("check");
  } catch {
    return fail("Can't decrypt this party's messages: the key in this invite link doesn't match. Ask your friend to copy the full invite link again.");
  }
  btn.href = btn.dataset.watch + "#npKey=" + m[1];
  btn.hidden = false;
  if (btn.dataset.host && btn.dataset.hpid) {
    try {
      const p = await open(btn.dataset.host, "netparty/e2ee/v1|" + room + "|profile|" + btn.dataset.hpid);
      const name = typeof p?.name === "string" ? [...p.name.replace(/[\\p{Cc}\\p{Cf}]/gu, "").replace(/\\s+/g, " ").trim()].slice(0, 24).join("") : "";
      if (name) h1.textContent = name + " invited you to a watch party";
    } catch {}
  }
})();`;
let cspCache = null;
// headers for the invite page: a CSP that allows only the script above (by hash) and forbids
// all network access from the page, and no Referer to the streaming site
export async function joinPageHeaders() {
  if (!cspCache) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JOIN_SCRIPT)));
    let bin = "";
    for (const b of digest) bin += String.fromCharCode(b);
    cspCache = `default-src 'none'; script-src 'sha256-${btoa(bin)}'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  }
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": cspCache,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
  };
}

export function joinPage(room, code, { hasDownload = false } = {}) {
  const live = !!room && !room.ended && !room.legacy && room.e2ee === true;
  const site = siteFor(room?.state?.videoId);
  const watch = live ? watchUrlFor(room.state.videoId, room.id) : null;
  const hostProfile = live && room.hostId ? room.profiles.get(room.hostId) || "" : "";
  const body = !live
    ? `<h1>This party has ended</h1><p>Ask your friend for a fresh invite link.</p>`
    : !watch
      ? `<h1>You're invited to a watch party</h1><p>The host hasn't opened a title yet. Try this link again in a moment.</p>`
      : `<h1>You're invited to a watch party</h1>
<p class="sub">${room.members.size ? room.members.size + " watching" : "Live"} on ${site} · party <code>${esc(room.id)}</code></p>
<p class="warn" id="warn" hidden></p>
<a class="btn" id="go" hidden href="${esc(watch)}" data-watch="${esc(watch)}" data-room="${esc(room.id)}" data-kc="${esc(room.kc || "")}" data-host="${esc(hostProfile)}" data-hpid="${esc(room.hostId || "")}">Join on ${site}</a>
<noscript><p class="warn">Turn on JavaScript for this page: it unlocks the party's encrypted chat with the key in your invite link.</p></noscript>
<p class="note">🔒 Chat is end-to-end encrypted. The key is in your invite link and never reaches our server.</p>
<p class="note">${site === "YouTube" ? "You need" : `You need your own ${site} account and`} the NetParty extension (1.7 or newer) in Chrome (or Edge, Brave).</p>
<details${hasDownload ? "" : " open"}><summary>Don't have NetParty yet?</summary>
<ol>
${hasDownload ? `<li><a href="/j/${esc(room.id)}/netparty.zip">Download NetParty</a> and unzip it.</li>` : `<li>Ask your friend to send you the NetParty zip, then unzip it.</li>`}
<li>Open <code>chrome://extensions</code> and switch on <b>Developer mode</b> (top right).</li>
<li>Click <b>Load unpacked</b> and pick the unzipped folder (the one with <code>manifest.json</code> inside).</li>
<li>Come back here and press <b>Join on ${site}</b>.</li>
</ol></details>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NetParty invite</title><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<meta property="og:title" content="You're invited to a NetParty"><meta property="og:description" content="Join the watch party: synced playback, encrypted chat and voice."><meta property="og:image" content="https://netparty.tech/og.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="https://netparty.tech/og.jpg">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121216;color:#f3f3f6;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:460px;padding:32px 24px}
.logo{font-weight:800;color:#a48bff;letter-spacing:.02em;margin-bottom:18px}
h1{font-size:24px;line-height:1.25;margin:0 0 8px}.sub{color:#9d9da8;margin:0 0 22px}
.btn{display:block;text-align:center;padding:14px;border-radius:12px;background:#7c5cff;color:#fff;font-weight:700;text-decoration:none}
.btn:hover{background:#a48bff}.note{color:#9d9da8;font-size:14px}[hidden]{display:none!important}
.warn{padding:12px 14px;border:1px solid #ff6b81;border-radius:12px;background:#2a1820;color:#ffd5dc}
details{margin-top:18px;padding:14px 16px;border:1px solid #33333c;border-radius:12px;background:#1b1b22}
summary{cursor:pointer;font-weight:600}ol{padding-left:20px;margin:10px 0 0}li{margin:6px 0}
a{color:#a48bff}code{background:#26262e;padding:1px 6px;border-radius:6px;font-size:14px}
</style></head><body><main><div class="logo">NetParty</div>${body}</main>${live && watch ? `<script>${JOIN_SCRIPT}</script>` : ""}</body></html>`;
}
