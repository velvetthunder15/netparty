// NetParty room logic, transport-agnostic. Used by the Node server (server.js)
// and the Cloudflare Worker (worker/). Protocol: JSON frames { type, reqId?, data? }.
const ROOM_TTL_MS = 10 * 60 * 1000; // keep an empty room this long
const MAX_CHAT = 500;
const MAX_MEMBERS = 50;

export function defaultIceServers(env = {}) {
  const ice = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  if (env.TURN_URL) ice.push({ urls: env.TURN_URL.split(","), username: env.TURN_USER, credential: env.TURN_PASS });
  return ice;
}

export function createHub({ iceServers = defaultIceServers() } = {}) {
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
  return [...room.members.values()].map((m) => ({ id: m.id, name: m.name, host: m.id === room.hostId, inVoice: !!m.inVoice }));
}

function snapshot(room) {
  return { roomId: room.id, hostId: room.hostId, hostOnly: room.hostOnly, state: room.state, members: memberList(room) };
}

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

function leaveRoom(client) {
  const room = client.roomId && rooms.get(client.roomId);
  client.roomId = null;
  if (!room) return;
  if (client.inVoice) broadcast(room, { type: "voice", data: { event: "leave", id: client.id } }, client.id);
  client.inVoice = false;
  room.members.delete(client.id);
  if (room.members.size === 0) {
    room.emptySince = Date.now();
    return;
  }
  if (room.hostId === client.id) room.hostId = room.members.keys().next().value;
  broadcast(room, { type: "members", data: { members: memberList(room), hostId: room.hostId } });
  broadcast(room, { type: "system", data: { text: `${client.name} left` } });
}

function joinRoom(client, room) {
  if (client.roomId) leaveRoom(client);
  room.members.set(client.id, client);
  room.emptySince = null;
  client.roomId = room.id;
  broadcast(room, { type: "members", data: { members: memberList(room), hostId: room.hostId } }, client.id);
  broadcast(room, { type: "system", data: { text: `${client.name} joined` } }, client.id);
}

const handlers = {
  time(client, _data, reply) {
    reply({ serverTime: Date.now() });
  },

  create(client, data, reply) {
    let id;
    do id = newId(8);
    while (rooms.has(id));
    client.name = cleanName(data?.name);
    const now = Date.now();
    /** @type {Room} */
    const room = {
      id,
      members: new Map(),
      hostId: client.id,
      hostOnly: !!data?.hostOnly,
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
    reply(snapshot(room));
  },

  join(client, data, reply) {
    const room = rooms.get(String(data?.roomId || "").toLowerCase());
    if (!room) return reply(null, "Party not found. It may have ended.");
    if (room.members.size >= MAX_MEMBERS) return reply(null, "Party is full.");
    client.name = cleanName(data?.name);
    joinRoom(client, room);
    reply(snapshot(room));
  },

  leave(client, _data, reply) {
    leaveRoom(client);
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
    broadcast(room, { type: "state", data: { ...room.state, byName: client.name, reason: data.reason || null } }, client.id);
    reply({ ok: true });
  },

  chat(client, data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    if (!room) return reply(null, "Not in a party.");
    const text = String(data?.text || "").trim().slice(0, MAX_CHAT);
    if (!text) return reply(null, "Empty message.");
    const msg = { type: "chat", data: { id: client.id, name: client.name, text, ts: Date.now() } };
    broadcast(room, msg);
    reply({ ok: true });
  },

  rename(client, data, reply) {
    client.name = cleanName(data?.name);
    const room = client.roomId && rooms.get(client.roomId);
    if (room) broadcast(room, { type: "members", data: { members: memberList(room), hostId: room.hostId } });
    reply({ ok: true });
  },

  settings(client, data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    if (!room) return reply(null, "Not in a party.");
    if (client.id !== room.hostId) return reply(null, "Only the host can change settings.");
    room.hostOnly = !!data?.hostOnly;
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
        fn(client, msg.data, reply);
      } catch (e) {
        console.error(e);
        reply(null, "Server error.");
      }
    },
    close() {
      leaveRoom(client);
    },
  };
}

function sweep() {
  const now = Date.now();
  for (const [id, room] of rooms) if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) rooms.delete(id);
}

return { connect, sweep, rooms };
}
