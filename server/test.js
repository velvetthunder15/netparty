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
        const w = { pred: (m) => m.type === type && pred(m), res: (m) => (clearTimeout(w.t), inbox.splice(inbox.indexOf(m), 1), res(m)) };
        waiters.push(w);
        // a waiter that timed out must not swallow a later message
        w.t = setTimeout(() => (waiters.includes(w) && waiters.splice(waiters.indexOf(w), 1), rej(new Error("timeout waiting for " + type))), 3000);
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

// ---- 1.6: avatars
{
  await assert.rejects(a.req("avatar", { avatar: "<b>" }), /Bad avatar/);
  await assert.rejects(a.req("avatar", { avatar: "ab" }), /Bad avatar/);
  await assert.rejects(a.req("avatar", { avatar: "🐶🐱🐼" }), /Bad avatar/); // more than one emoji
  await assert.rejects(a.req("avatar", { avatar: "🐶 " }), /Bad avatar/);
  await assert.rejects(a.req("avatar", { avatar: 42 }), /Bad avatar/);
  await a.req("avatar", { avatar: "🦊" });
  const m = await b.next("members", (x) => x.data.members.some((p) => p.id === aId && p.avatar === "🦊"));
  assert.ok(m);
  await a.next("members"); // sender gets the list too
  await b.req("avatar", { avatar: "🐙" }); // any single emoji, allowlisted
  await a.next("members", (x) => x.data.members.some((p) => p.id === bId && p.avatar === "🐙"));
  await a.req("avatar", { avatar: "🧑🏽‍🚀" }); // not in the list, but one emoji (ZWJ + skin tone), 7 UTF-16 units
  await b.next("members", (x) => x.data.members.some((p) => p.id === aId && p.avatar === "🧑🏽‍🚀"));
  await a.req("avatar", { avatar: "🦊" });
  await b.next("members", (x) => x.data.members.some((p) => p.id === aId && p.avatar === "🦊"));
  await b.req("chat", { text: "with avatar" });
  const c1 = await a.next("chat", (x) => x.data.text === "with avatar");
  assert.equal(c1.data.avatar, "🐙");
  await b.next("chat");
  // join/create sanitize a bad avatar to null instead of failing
  const z = client();
  await z.ready;
  await z.next("welcome");
  const zs = await z.req("join", { roomId: snap.roomId, name: "Zed", avatar: "javascript:alert(1)" });
  assert.equal(zs.members.find((p) => p.name === "Zed").avatar, null);
  assert.equal(zs.members.find((p) => p.id === aId).avatar, "🦊");
  assert.equal(zs.history.filter((h) => h.kind === "chat").at(-1).avatar, "🐙");
  z.close();
  await a.next("members", (x) => x.data.members.length === 3);
  ok("avatars: validate, broadcast, in members, chat lines and history");
}

// ---- 1.6: reactions
{
  await assert.rejects(a.req("react", { emoji: "lol" }), /Bad reaction/);
  await assert.rejects(a.req("react", { emoji: "😂😂" }), /Bad reaction/);
  await assert.rejects(a.req("react", { emoji: "<img src=x>" }), /Bad reaction/);
  await assert.rejects(a.req("react", {}), /Bad reaction/);
  await a.req("react", { emoji: "😂" });
  const r = await b.next("react");
  assert.equal(r.data.emoji, "😂");
  assert.equal(r.data.id, aId);
  assert.equal(r.data.name, "Chirag");
  assert.equal(r.data.avatar, "🦊");
  for (let i = 0; i < 5; i++) await a.req("react", { emoji: "🥰" });
  await assert.rejects(a.req("react", { emoji: "🥰" }), /Slow down/); // 7th within 3 s
  for (let i = 0; i < 5; i++) await b.next("react");
  assert.equal(await a.next("react").catch(() => null), null); // sender doesn't get its own back
  await b.req("react", { emoji: "💀" }); // the limit is per connection
  await a.next("react", (x) => x.data.emoji === "💀");
  const snapAfter = await b.req("join", { roomId: snap.roomId, name: "Friend" });
  assert.ok(!snapAfter.history.some((h) => h.kind === "react" || /🥰/.test(h.text || "")), "reactions are not kept");
  await a.next("members").catch(() => {});
  ok("reactions: broadcast to others, validated, rate limited (6 per 3 s), not in history");
}

// ---- 1.6: GIF messages
{
  const good = "https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/ec/f3/NIKSFkmQ.gif";
  await b.req("chat", { gif: { url: good, w: 220, h: 160 } });
  const g = await a.next("chat", (x) => !!x.data.gif);
  assert.deepEqual(g.data.gif, { url: good, w: 220, h: 160 });
  assert.equal(g.data.text, "GIF");
  await b.next("chat");
  await b.req("chat", { gif: { url: good.replace("static.", "static2."), w: 9999, h: "x" } });
  const g2 = await a.next("chat", (x) => !!x.data.gif);
  assert.deepEqual(g2.data.gif, { url: good.replace("static.", "static2."), w: null, h: null });
  await b.next("chat");
  for (const bad of [
    "http://static.klipy.com/a.gif",
    "https://evil.com/a.gif",
    "https://static.klipy.com.evil.com/a.gif",
    "https://user@static.klipy.com/a.gif",
    "https://static.klipy.com:8443/a.gif",
    "javascript:alert(1)",
    "data:image/gif;base64,R0lGODlh",
    "https://static.klipy.com/" + "a".repeat(600),
    "",
  ])
    await assert.rejects(b.req("chat", { gif: { url: bad } }), /Bad GIF/, bad);
  await assert.rejects(b.req("chat", { gif: "x" }), /Bad GIF/);
  await assert.rejects(b.req("chat", { gif: null }), /Bad GIF/);
  const h = (await b.req("join", { roomId: snap.roomId, name: "Friend" })).history;
  assert.equal(h.filter((x) => x.gif).length, 2);
  await a.next("members").catch(() => {});
  ok("GIF chat: KLIPY https media only, sizes sanitized, kept in history");
}

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

{
  // YouTube party: invite page names YouTube and links to the watch page
  const y = client();
  await y.ready;
  await y.next("welcome");
  const ys = await y.req("create", { name: "Tuber", videoId: "yt:dQw4w9WgXcQ", playing: false, position: 0, at: Date.now() });
  const html = await (await fetch(`${TARGET.replace(/^ws/, "http")}/j/${ys.roomId}`)).text();
  assert.match(html, /Join on YouTube/);
  assert.ok(!/Netflix/.test(html));
  assert.ok(html.includes(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;npParty=${ys.roomId}`));
  await y.req("end", {});
  y.close();
  ok("YouTube invite page");
}

{
  // GIF search proxy: without a key it says so (503); with one it normalizes KLIPY's answer
  const http = TARGET.replace(/^ws/, "http");
  const r0 = await fetch(`${http}/api/gifs/trending`, { headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
  const j0 = await r0.json();
  if (r0.status === 503) assert.equal(j0.error, "gifs_unavailable");
  else assert.ok(r0.status === 200 && Array.isArray(j0.results), JSON.stringify(j0));
  assert.equal(r0.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
  const evil = await fetch(`${http}/api/gifs/trending`, { headers: { origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(`${http}/api/gifs/search`)).status, r0.status === 503 ? 400 : 400);
  assert.equal((await fetch(`${http}/api/gifs/nope`)).status, 404);
  if (!process.env.TARGET) {
    // mock KLIPY (Tenor-compatible v2 shape)
    const { createServer } = await import("node:http");
    let lastQ = null;
    const mock = createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      lastQ = u.searchParams;
      const item = (id, host = "static.klipy.com") => ({ id, title: "t" + id, media_formats: {
        tinygif: { url: `https://${host}/ii/x/${id}.gif`, dims: [220, 124] }, nanogif: { url: `https://${host}/ii/x/${id}n.gif`, dims: [90, 50] } } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [item("1"), item("2", "evil.com"), item("3", "static1.klipy.com")], next: "abc=" }));
    });
    await new Promise((r) => mock.listen(0, r));
    process.env.KLIPY_KEY = "test-key";
    process.env.KLIPY_BASE = `http://127.0.0.1:${mock.address().port}`;
    const r1 = await fetch(`${http}/api/gifs/search?q=${encodeURIComponent("Stranger Things")}&pos=`);
    const j1 = await r1.json();
    assert.equal(r1.status, 200);
    assert.equal(lastQ.get("q"), "Stranger Things");
    assert.equal(lastQ.get("key"), "test-key");
    assert.equal(lastQ.get("contentfilter"), "medium");
    assert.equal(j1.next, "abc=");
    assert.deepEqual(j1.results.map((x) => x.id), ["1", "3"]); // off-host media dropped
    assert.deepEqual(j1.results[0], { id: "1", url: "https://static.klipy.com/ii/x/1.gif", preview: "https://static.klipy.com/ii/x/1.gif", w: 220, h: 124, title: "t1" });
    assert.ok(!JSON.stringify(j1).includes("test-key"));
    lastQ = null;
    await fetch(`${http}/api/gifs/search?q=${encodeURIComponent("Stranger Things")}`);
    assert.equal(lastQ, null, "second identical search is served from cache");
    const r2 = await fetch(`${http}/api/gifs/trending?pos=abc%3D`);
    assert.equal(r2.status, 200);
    assert.equal(lastQ.get("pos"), "abc=");
    delete process.env.KLIPY_KEY;
    delete process.env.KLIPY_BASE;
    mock.close();
  }
  ok("GIF proxy endpoints (" + (r0.status === 503 ? "no key: 503 gifs_unavailable" : "live") + ")");
}

{
  // page reload: same tab id rejoins silently, keeps host, gets chat history back
  const c = client(), d = client();
  await Promise.all([c.ready, d.ready]);
  await c.next("welcome");
  await d.next("welcome");
  const cs = await c.req("create", { name: "Host", cid: "tabid12345", videoId: "81234567", playing: true, position: 1000, at: Date.now() });
  await d.req("join", { roomId: cs.roomId, name: "Pal" });
  await c.req("chat", { text: "before reload" });
  await d.next("chat");
  c.close();
  await new Promise((r) => setTimeout(r, 300));
  const c2 = client();
  await c2.ready;
  const c2Id = (await c2.next("welcome")).data.userId;
  const back = await c2.req("join", { roomId: cs.roomId, name: "Host", cid: "tabid12345" });
  assert.equal(back.returning, true);
  assert.equal(back.hostId, c2Id);
  assert.equal(back.members.length, 2);
  const chat = back.history.find((h) => h.kind === "chat");
  assert.equal(chat.text, "before reload");
  assert.equal(chat.cid, "tabid12345");
  await new Promise((r) => setTimeout(r, 400));
  const spam = await d.next("system", (m) => /left|joined/.test(m.data.text)).catch(() => null);
  assert.equal(spam, null, "unexpected: " + JSON.stringify(spam?.data));
  ok("reload keeps seat, host role and chat history (no left/joined spam)");
  c2.close();
  d.close();
}

{
  // host ends the party: everyone is told, the code stops working
  const e = client(), f = client();
  await Promise.all([e.ready, f.ready]);
  await e.next("welcome");
  await f.next("welcome");
  const es = await e.req("create", { name: "Host", cid: "endtest1234", videoId: "81234567", playing: false, position: 0, at: Date.now() });
  await f.req("join", { roomId: es.roomId, name: "Pal" });
  await assert.rejects(f.req("end", {}), /Only the host/);
  await e.req("end", {});
  const ended = await f.next("ended");
  assert.equal(ended.data.byName, "Host");
  await assert.rejects(f.req("join", { roomId: es.roomId, name: "Pal" }), /not found/);
  await assert.rejects(f.req("chat", { text: "hi" }), /Not in a party/);
  const http = TARGET.replace(/^ws/, "http");
  assert.equal((await fetch(`${http}/j/${es.roomId}`)).status, 404);
  ok("host ends party for everyone");
  e.close();
  f.close();
}

{
  // server restart: a party saved to the store comes back with state, host and chat
  const { createHub } = await import("./core.js");
  const disk = new Map();
  const store = { get: async (k) => structuredClone(disk.get(k) ?? null), put: async (k, v) => disk.set(k, structuredClone(v)), del: async (k) => disk.delete(k) };
  const fake = (hub) => {
    const inbox = [];
    let seq = 0;
    const waits = new Map();
    const conn = hub.connect((raw) => {
      const m = JSON.parse(raw);
      if (m.type === "reply") waits.get(m.reqId)?.(m);
      else inbox.push(m);
    });
    return {
      inbox,
      conn,
      req: (type, data) =>
        new Promise((res, rej) => {
          const reqId = ++seq;
          waits.set(reqId, (m) => (m.error ? rej(new Error(m.error)) : res(m.data)));
          conn.message(JSON.stringify({ type, reqId, data }));
        }),
    };
  };
  const hub1 = createHub({ store });
  const h = fake(hub1);
  const s1 = await h.req("create", { name: "Host", cid: "persist12345", videoId: "81234567", playing: true, position: 42000, at: Date.now() });
  await h.req("chat", { text: "survive this" });
  await new Promise((r) => setTimeout(r, 450));
  const hub2 = createHub({ store }); // "restart": nothing in memory
  const g = fake(hub2);
  const gs = await g.req("join", { roomId: s1.roomId, name: "Pal", cid: "guest1234567" });
  assert.equal(gs.state.position, 42000);
  assert.equal(gs.history.find((x) => x.kind === "chat").text, "survive this");
  const h2 = fake(hub2);
  const hs = await h2.req("join", { roomId: s1.roomId, name: "Host", cid: "persist12345" });
  assert.equal(hs.hostId, h2.conn.id); // creator gets host back
  assert.ok(await hub2.findRoom(s1.roomId));
  await h2.req("end", {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(disk.size, 0);
  ok("party survives a server restart (store) and is deleted when ended");
}

// host leaves -> host passes to B, and B's voice-state cleanup on disconnect
a.close();
const sysLeft = await b.next("system", (m) => /Chirag left/.test(m.data.text));
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
