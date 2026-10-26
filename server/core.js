// NetParty room logic, transport-agnostic. Used by the Node server (server.js)
// and the Cloudflare Worker (worker/). Protocol: JSON frames { type, reqId?, data? }.
const ROOM_TTL_MS = 10 * 60 * 1000; // keep an empty room this long
const MAX_CHAT = 500;
const MAX_MEMBERS = 50;
const HISTORY = 150; // chat + system lines replayed to anyone who (re)joins
const GRACE_MS = 15_000; // a dropped connection keeps its seat (and host role) this long

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
    reply(snapshot(room));
  },

  join(client, data, reply) {
    const room = rooms.get(String(data?.roomId || "").toLowerCase());
    if (!room) return reply(null, "Party not found. It may have ended.");
    if (room.members.size >= MAX_MEMBERS) return reply(null, "Party is full.");
    client.name = cleanName(data?.name);
    client.cid = cleanCid(data?.cid);
    const returning = joinRoom(client, room);
    reply({ ...snapshot(room), returning });
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
    const line = { id: client.id, cid: client.cid, name: client.name, text, ts: Date.now() };
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

  settings(client, data, reply) {
    const room = client.roomId && rooms.get(client.roomId);
    if (!room) return reply(null, "Not in a party.");
    if (client.id !== room.hostId) return reply(null, "Only the host can change settings.");
    room.hostOnly = !!data?.hostOnly;
    room.hostCid = client.cid;
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
  for (const [id, room] of rooms) if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) rooms.delete(id);
}

return { connect, sweep, rooms, getRoom: (code) => rooms.get(String(code || "").toLowerCase()) };
}

// ---------------------------------------------------------------- invite page
// GET /j/<code> on the party server. Friends land here from an invite link: it sends
// them to the right title (where the extension auto-joins), or tells them how to
// install NetParty first. The extension download only works while the party is live.
export function watchUrlFor(videoId, roomId) {
  if (!videoId) return null;
  const base = videoId.startsWith("hs:")
    ? "https://www.hotstar.com" + videoId.slice(3)
    : "https://www.netflix.com/watch/" + encodeURIComponent(videoId);
  return `${base}?npParty=${encodeURIComponent(roomId)}`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function joinPage(room, code, { hasDownload = false } = {}) {
  const live = !!room && room.members.size > 0;
  const host = live ? [...room.members.values()].find((m) => m.id === room.hostId) : null;
  const site = room?.state.videoId?.startsWith("hs:") ? "JioHotstar" : "Netflix";
  const watch = live ? watchUrlFor(room.state.videoId, room.id) : null;
  const body = !live
    ? `<h1>This party has ended</h1><p>Ask your friend for a fresh invite link.</p>`
    : `<h1>${esc(host?.name || "A friend")} invited you to a watch party</h1>
<p class="sub">${room.members.size} watching on ${site} · party <code>${esc(room.id)}</code></p>
<a class="btn" href="${esc(watch)}">Join on ${site}</a>
<p class="note">You need your own ${site} account and the NetParty extension in Chrome (or Edge, Brave).</p>
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
