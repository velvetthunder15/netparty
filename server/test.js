// End-to-end protocol test: two clients create/join, sync, chat, voice signaling.
import { WebSocket } from "ws";
import assert from "node:assert/strict";

// TARGET=wss://host runs the suite against a deployed server instead of a local one.
const PORT = 18000 + Math.floor(Math.random() * 1000);
const TARGET = process.env.TARGET || `ws://localhost:${PORT}`;
let server = null;
if (!process.env.TARGET) {
  process.env.PORT = String(PORT);
  ({ server } = await import("./server.js"));
  await new Promise((r) => server.listening ? r() : server.once("listening", r));
}

function client() {
  const ws = new WebSocket(TARGET);
  const inbox = [];
  const waiters = [];
  let seq = 0;
  const replies = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "reply") return replies.get(m.reqId)?.(m);
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.res(m));
  });
  return {
    ready: new Promise((r) => ws.once("open", r)),
    req(type, data) {
      const reqId = ++seq;
      ws.send(JSON.stringify({ type, reqId, data }));
      return new Promise((res, rej) => replies.set(reqId, (m) => (m.error ? rej(new Error(m.error)) : res(m.data))));
    },
    next(type, pred = () => true) {
      const hit = inbox.find((m) => m.type === type && pred(m));
      if (hit) return (inbox.splice(inbox.indexOf(hit), 1), Promise.resolve(hit));
      return new Promise((res, rej) => {
        waiters.push({ pred: (m) => m.type === type && pred(m), res: (m) => (inbox.splice(inbox.indexOf(m), 1), res(m)) });
        setTimeout(() => rej(new Error("timeout waiting for " + type)), 3000);
      });
    },
    close: () => ws.close(),
  };
}

const ok = (name) => console.log("✔", name);

const a = client(), b = client();
await Promise.all([a.ready, b.ready]);
const aId = (await a.next("welcome")).data.userId;
const bId = (await b.next("welcome")).data.userId;
ok("welcome + user ids");

const t = await a.req("time", {});
assert.ok(Math.abs(t.serverTime - Date.now()) < 1000);
ok("time sync endpoint");

const snap = await a.req("create", { name: "Chirag", videoId: "81234567", playing: false, position: 5000, at: Date.now() });
assert.equal(snap.state.videoId, "81234567");
assert.equal(snap.hostId, aId);
ok("create party " + snap.roomId);

await assert.rejects(b.req("join", { roomId: "nope", name: "X" }), /not found/);
ok("join bad code rejected");

const jsnap = await b.req("join", { roomId: snap.roomId.toUpperCase(), name: "Friend" });
assert.equal(jsnap.members.length, 2);
assert.equal(jsnap.state.position, 5000);
const mem = await a.next("members");
assert.equal(mem.data.members.length, 2);
ok("join + member broadcast");

const at = Date.now();
await a.req("state", { playing: true, position: 6000, at, videoId: "81234567", reason: "play" });
const st = await b.next("state");
assert.equal(st.data.playing, true);
assert.equal(st.data.position, 6000);
assert.equal(st.data.at, at);
assert.equal(st.data.byName, "Chirag");
ok("playback state relayed (sender excluded)");

await assert.rejects(a.req("state", { playing: "yes", position: -1 }), /Bad state/);
ok("invalid state rejected");

await a.req("settings", { hostOnly: true });
await b.next("settings");
await assert.rejects(b.req("state", { playing: false, position: 1, at: Date.now() }), /host/);
await assert.rejects(b.req("settings", { hostOnly: false }), /host/);
await a.req("settings", { hostOnly: false });
await b.req("state", { playing: false, position: 7000, at: Date.now(), reason: "pause" });
assert.equal((await a.next("state")).data.playing, false);
ok("host-only control lock");

await b.req("chat", { text: "  hello 👋  " });
const ca = await a.next("chat"), cb = await b.next("chat");
assert.equal(ca.data.text, "hello 👋");
assert.equal(cb.data.name, "Friend");
await assert.rejects(a.req("chat", { text: "   " }), /Empty/);
ok("text chat to everyone incl. sender");

// voice: A joins first, B joins and gets A as a peer to call
const va = await a.req("voiceJoin", {});
assert.deepEqual(va.peers, []);
assert.ok(va.iceServers.length >= 1);
const vb = await b.req("voiceJoin", {});
assert.deepEqual(vb.peers, [aId]);
const ve = await a.next("voice", (m) => m.data.event === "join");
assert.equal(ve.data.id, bId);
const mv = await a.next("members", (m) => m.data.members.every((x) => x.inVoice));
assert.ok(mv);
ok("voice join + peer list + inVoice flags");

await b.req("signal", { to: aId, payload: { sdp: { type: "offer", sdp: "v=0..." } } });
const sig = await a.next("signal");
assert.equal(sig.data.from, bId);
assert.equal(sig.data.payload.sdp.type, "offer");
await a.req("signal", { to: bId, payload: { ice: { candidate: "candidate:1 1 udp ..." } } });
assert.ok((await b.next("signal")).data.payload.ice);
await assert.rejects(a.req("signal", { to: "ghost", payload: {} }), /Peer/);
ok("WebRTC signaling relay (offer + ICE)");

await b.req("voiceState", { muted: true, speaking: false });
const vs = await a.next("voice", (m) => m.data.event === "state");
assert.equal(vs.data.muted, true);
ok("mute/speaking state");

await b.req("voiceLeave", {});
assert.equal((await a.next("voice", (m) => m.data.event === "leave")).data.id, bId);
ok("voice leave");

{
  const http = TARGET.replace(/^ws/, "http");
  const page = await fetch(`${http}/j/${snap.roomId}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /invited you/);
  assert.ok(html.includes(`https://www.netflix.com/watch/81234567?npParty=${snap.roomId}`));
  const dl = await fetch(`${http}/j/${snap.roomId}/netparty.zip`);
  console.log("  (extension download: HTTP " + dl.status + ")");
  assert.ok(dl.status === 200 || dl.status === 404); // 404 when the server has no zip configured
  if (dl.status === 200) assert.ok((await dl.arrayBuffer()).byteLength > 5000);
  const gone = await fetch(`${http}/j/zzzzzzzz`);
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /ended/);
  const zip = await fetch(`${http}/j/zzzzzzzz/netparty.zip`);
  assert.equal(zip.status, 404);
  ok("invite page (live party, ended party, gated download)");
}

// host leaves -> host passes to B, and B's voice-state cleanup on disconnect
a.close();
const sysLeft = await b.next("system", (m) => /left/.test(m.data.text));
const after = await b.next("members", (m) => m.data.members.length === 1);
assert.equal(after.data.hostId, bId);
ok("host handoff on disconnect (" + sysLeft.data.text + ")");

b.close();
const res = await fetch(TARGET.replace(/^ws/, "http") + "/health").then((r) => r.json());
assert.equal(res.ok, true);
ok("health endpoint");

console.log("\nAll server tests passed.");
server?.close();
process.exit(0);
process.exit(0);
