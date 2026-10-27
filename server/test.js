// End-to-end protocol test: clients create/join, sync, end-to-end encrypted chat, profiles,
// reactions and voice signaling, private reconnect ids (cid) vs public member ids (pid).
// The clients here encrypt exactly like the extension (extension/content.js, `e2e`), with
// Node's WebCrypto, so the server only ever sees what a real 1.7 browser would send.
import { WebSocket } from "ws";
import assert from "node:assert/strict";

// TARGET=wss://host runs the suite against a deployed server instead of a local one.
const PORT = 18000 + Math.floor(Math.random() * 1000);
const TARGET = process.env.TARGET || `ws://localhost:${PORT}`;
const HTTP = TARGET.replace(/^ws/, "http");
let server = null;
if (!process.env.TARGET) {
  process.env.PORT = String(PORT);
  ({ server } = await import("./server.js"));
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
}

// ---------------------------------------------------------------- crypto (same as the extension)
const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const genKey = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
const importKey = (s) => crypto.subtle.importKey("raw", unb64u(s), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
const aad = (room, kind, pid) => enc.encode(`netparty/e2ee/v1|${room}|${kind}|${pid}`);
async function seal(keyStr, room, kind, pid, obj) {
  const json = enc.encode(JSON.stringify(obj));
  const pt = new Uint8Array(Math.max(64, Math.ceil(json.length / 64) * 64)).fill(0x20);
  pt.set(json);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(room, kind, pid) }, await importKey(keyStr), pt));
  return b64u(Buffer.concat([Buffer.from([1]), iv, ct]));
}
async function open(keyStr, room, kind, pid, s) {
  try {
    const b = unb64u(s);
    if (b[0] !== 1) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(1, 13), additionalData: aad(room, kind, pid) }, await importKey(keyStr), b.subarray(13));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}
const check = (key) => seal(key, "", "check", "", { check: "netparty" });
const newCid = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
const CT_RE = /^[A-Za-z0-9_-]+$/;

// every frame any test client ever received, to look for leaks at the end
const allFrames = [];
function client(label = "") {
  const ws = new WebSocket(TARGET);
  const inbox = [];
  const frames = [];
  const waiters = [];
  let seq = 0;
  const replies = new Map();
  ws.on("message", (raw) => {
    const text = raw.toString();
    frames.push(text);
    allFrames.push({ label, text });
    const m = JSON.parse(text);
    if (m.type === "reply") return replies.get(m.reqId)?.(m);
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.res(m));
  });
  return {
    frames,
    ready: new Promise((r) => ws.once("open", r)),
    req(type, data) {
      const reqId = ++seq;
      ws.send(JSON.stringify({ type, reqId, data }));
      return new Promise((res, rej) => replies.set(reqId, (m) => (m.error ? rej(new Error(m.error)) : res(m.data))));
    },
    next(type, pred = () => true, ms = 3000) {
      const hit = inbox.find((m) => m.type === type && pred(m));
      if (hit) return (inbox.splice(inbox.indexOf(hit), 1), Promise.resolve(hit));
      return new Promise((res, rej) => {
        const w = { pred: (m) => m.type === type && pred(m), res: (m) => (clearTimeout(w.t), inbox.splice(inbox.indexOf(m), 1), res(m)) };
        waiters.push(w);
        // a waiter that timed out must not swallow a later message
        w.t = setTimeout(() => (waiters.includes(w) && waiters.splice(waiters.indexOf(w), 1), rej(new Error("timeout waiting for " + type))), ms);
      });
    },
    drain: (type) => {
      for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].type === type) inbox.splice(i, 1);
    },
    close: () => ws.close(),
  };
}
const ok = (name) => console.log("✔", name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a 1.7 member: knows the room key, its cid (private) and its pid (public, from the server)
async function member(label, { key, room, cid = newCid(), create = null } = {}) {
  const c = client(label);
  await c.ready;
  await c.next("welcome");
  let snap;
  if (create) snap = await c.req("create", { e2ee: 1, cid, kc: await check(key), ...create });
  else snap = await c.req("join", { e2ee: 1, roomId: room, cid });
  return Object.assign(c, { cid, key, room: snap.roomId, pid: snap.you, snap });
}
const sealAs = (m, kind, obj) => seal(m.key, m.room, kind, m.pid, obj);

// ---------------------------------------------------------------- basics
const KEY = genKey();
const MARK = "PLAINTEXT-MARKER-" + b64u(crypto.getRandomValues(new Uint8Array(6)));
{
  const w = client("w");
  await w.ready;
  const welcome = await w.next("welcome");
  assert.equal(welcome.data.e2ee, true);
  assert.equal(welcome.data.userId, undefined, "no connection id handed out any more");
  const t = await w.req("time", {});
  assert.ok(Math.abs(t.serverTime - Date.now()) < 1000);
  w.close();
  ok("welcome (e2ee, no ids) + time sync");
}

// old (1.6) clients: no e2ee announcement -> clear "update" error everywhere
{
  const old = client("old");
  await old.ready;
  await old.next("welcome");
  await assert.rejects(old.req("create", { name: "Old", videoId: "81234567", cid: "abcdefgh12345678" }), /Update NetParty/);
  old.close();
  ok("1.6 client can't create (asked to update)");
}

const a = await member("a", { key: KEY, create: { videoId: "81234567", playing: false, position: 5000, at: Date.now() } });
const snap = a.snap;
assert.equal(snap.e2ee, true);
assert.equal(snap.state.videoId, "81234567");
assert.match(a.pid, /^[a-z0-9]{12}$/);
assert.equal(snap.hostId, a.pid);
assert.equal(snap.state.by, a.pid);
assert.ok(CT_RE.test(snap.kc));
assert.ok(!JSON.stringify(snap).includes(a.cid), "own cid not echoed");
ok("create e2ee party " + snap.roomId + " (pid " + a.pid + ")");

{
  const x = client("x");
  await x.ready;
  await x.next("welcome");
  await assert.rejects(x.req("create", { e2ee: 1, videoId: "1", kc: await check(KEY) }), /Bad client id/);
  await assert.rejects(x.req("create", { e2ee: 1, cid: "tabid12345", kc: await check(KEY) }), /Bad client id/); // old 16-char ids aren't secret enough
  await assert.rejects(x.req("create", { e2ee: 1, cid: newCid(), kc: "not base64url!" }), /Bad key check/);
  await assert.rejects(x.req("create", { e2ee: 1, cid: newCid() }), /Bad key check/);
  await assert.rejects(x.req("join", { e2ee: 1, roomId: "nope", cid: newCid() }), /not found/);
  await assert.rejects(x.req("join", { e2ee: 1, roomId: snap.roomId }), /Bad client id/);
  // 1.6 client joining / peeking an encrypted party
  await assert.rejects(x.req("join", { roomId: snap.roomId, name: "Old", cid: "abcdefgh12345678" }), /Update NetParty/);
  await assert.rejects(x.req("peek", { roomId: snap.roomId }), /Update NetParty/);
  const pk = await x.req("peek", { e2ee: 1, roomId: snap.roomId });
  assert.deepEqual(Object.keys(pk).sort(), ["e2ee", "kc", "members", "roomId", "videoId"]);
  assert.equal(pk.e2ee, true);
  assert.equal(pk.kc, snap.kc);
  assert.deepEqual(await open(KEY, "", "check", "", pk.kc), { check: "netparty" });
  assert.equal(await open(genKey(), "", "check", "", pk.kc), null, "a wrong key fails the check");
  x.close();
  ok("create/join validation; 1.6 clients rejected from e2ee parties; peek gives the key check");
}

const b = await member("b", { key: KEY, room: snap.roomId.toUpperCase() });
assert.equal(b.snap.members.length, 2);
assert.equal(b.snap.state.position, 5000);
assert.notEqual(b.pid, a.pid);
const mem = await a.next("members");
assert.equal(mem.data.members.length, 2);
assert.deepEqual(Object.keys(mem.data.members[0]).sort(), ["host", "id", "inVoice", "profile"]);
await a.next("system", (m) => m.data.event === "join" && m.data.id === b.pid);
ok("join + member broadcast (pid only) + join event without names");

// ---- profiles (encrypted name + avatar)
{
  await assert.rejects(a.req("profile", { name: "Chirag" }), /Bad profile/);
  await assert.rejects(a.req("profile", { ct: "x".repeat(5000) }), /Bad profile/);
  await assert.rejects(a.req("profile", { ct: "abc" }), /Bad profile/);
  await assert.rejects(a.req("profile", { ct: "a+b/c=".repeat(30) }), /Bad profile/);
  await a.req("profile", { ct: await sealAs(a, "profile", { name: "Chirag", avatar: "🦊" }) });
  await b.req("profile", { ct: await sealAs(b, "profile", { name: "Friend", avatar: "🐙" }) });
  const m = await b.next("members", (x) => x.data.members.every((p) => p.profile));
  const pa = m.data.members.find((p) => p.id === a.pid);
  assert.deepEqual(await open(KEY, snap.roomId, "profile", a.pid, pa.profile), { name: "Chirag", avatar: "🦊" });
  assert.equal(await open(KEY, snap.roomId, "profile", b.pid, pa.profile), null, "bound to its member: can't be passed off as someone else's");
  a.drain("members");
  b.drain("members");
  ok("encrypted profiles: shape-checked, relayed, bound to the member's pid");
}

const at = Date.now();
await a.req("state", { playing: true, position: 6000, at, videoId: "81234567", reason: "play" });
const st = await b.next("state");
assert.equal(st.data.playing, true);
assert.equal(st.data.position, 6000);
assert.equal(st.data.at, at);
assert.equal(st.data.by, a.pid);
assert.equal(st.data.byName, undefined);
await a.req("state", { playing: true, position: 6100, at: Date.now(), reason: "<script>hi</script>" });
assert.equal((await b.next("state")).data.reason, null, "only known reasons are relayed");
ok("playback state relayed (sender excluded, by = pid, no names)");

await assert.rejects(a.req("state", { playing: "yes", position: -1 }), /Bad state/);
await assert.rejects(a.req("state", { playing: true, position: 1, videoId: { x: 1 } }), /Bad state/);
ok("invalid state rejected");

await a.req("settings", { hostOnly: true });
await b.next("settings");
await assert.rejects(b.req("state", { playing: false, position: 1, at: Date.now() }), /host/);
await assert.rejects(b.req("settings", { hostOnly: false }), /host/);
await a.req("settings", { hostOnly: false });
await b.next("settings");
await b.req("state", { playing: false, position: 7000, at: Date.now(), reason: "pause" });
assert.equal((await a.next("state")).data.playing, false);
ok("host-only control lock");

// ---- encrypted chat
{
  await assert.rejects(b.req("chat", { text: "hello" }), /Bad message/, "plaintext is refused");
  await assert.rejects(b.req("chat", { ct: "" }), /Bad message/);
  await assert.rejects(b.req("chat", { ct: "A".repeat(4136) }), /Bad message/, "over the size limit");
  const longest = await sealAs(b, "chat", { t: "text", text: "\u0001".repeat(500) }); // worst case: every char escaped
  assert.ok(longest.length <= 4135, String(longest.length));
  await b.req("chat", { ct: longest });
  await a.next("chat");
  await b.next("chat");
  const ct = await sealAs(b, "chat", { t: "text", text: "hello 👋 " + MARK });
  await b.req("chat", { ct });
  const ca = await a.next("chat", (x) => x.data.ct === ct), cb = await b.next("chat", (x) => x.data.ct === ct);
  assert.deepEqual(Object.keys(ca.data).sort(), ["ct", "from", "ts"]);
  assert.equal(ca.data.from, b.pid);
  assert.equal(cb.data.from, b.pid);
  assert.deepEqual(await open(KEY, snap.roomId, "chat", ca.data.from, ca.data.ct), { t: "text", text: "hello 👋 " + MARK });
  // AAD binding: not in another party, not as another member, not as another kind, not with another key
  assert.equal(await open(KEY, "otherroom", "chat", b.pid, ct), null);
  assert.equal(await open(KEY, snap.roomId, "chat", a.pid, ct), null);
  assert.equal(await open(KEY, snap.roomId, "react", b.pid, ct), null);
  assert.equal(await open(genKey(), snap.roomId, "chat", b.pid, ct), null);
  // a GIF message is just another encrypted chat line
  const gifUrl = "https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/ec/f3/NIKSFkmQ.gif";
  await b.req("chat", { ct: await sealAs(b, "chat", { t: "gif", url: gifUrl, w: 220, h: 160 }) });
  const g = await a.next("chat");
  assert.deepEqual(await open(KEY, snap.roomId, "chat", b.pid, g.data.ct), { t: "gif", url: gifUrl, w: 220, h: 160 });
  await b.next("chat");
  // history keeps only ciphertext
  const again = await b.req("join", { e2ee: 1, roomId: snap.roomId, cid: b.cid });
  assert.equal(again.returning, true);
  const chats = again.history.filter((h) => h.kind === "chat");
  assert.ok(chats.length >= 3);
  for (const h of again.history) {
    if (h.kind === "chat") assert.deepEqual(Object.keys(h).sort(), ["ct", "from", "kind", "ts"]);
    else assert.deepEqual(Object.keys(h).sort(), ["event", "id", "kind", "ts"]);
  }
  assert.ok(!JSON.stringify(again).includes(MARK) && !JSON.stringify(again).includes("Friend") && !JSON.stringify(again).includes("klipy"));
  assert.ok(again.profiles[a.pid] && again.profiles[b.pid]);
  ok("encrypted chat + GIFs: ciphertext only (size-capped), relayed to all, AAD-bound, history is ciphertext");
}

// ---- encrypted reactions
{
  await assert.rejects(a.req("react", { emoji: "😂" }), /Bad reaction/);
  await assert.rejects(a.req("react", { ct: "A".repeat(211) }), /Bad reaction/);
  await assert.rejects(a.req("react", {}), /Bad reaction/);
  const r1 = await sealAs(a, "react", { e: "😂" });
  await a.req("react", { ct: r1 });
  const r = await b.next("react");
  assert.deepEqual(Object.keys(r.data).sort(), ["ct", "from", "ts"]);
  assert.equal(r.data.from, a.pid);
  assert.deepEqual(await open(KEY, snap.roomId, "react", a.pid, r.data.ct), { e: "😂" });
  for (let i = 0; i < 5; i++) await a.req("react", { ct: await sealAs(a, "react", { e: "🥰" }) });
  await assert.rejects(a.req("react", { ct: r1 }), /Slow down/); // 7th within 3 s
  for (let i = 0; i < 5; i++) await b.next("react");
  assert.equal(await a.next("react").catch(() => null), null); // sender doesn't get its own back
  await b.req("react", { ct: await sealAs(b, "react", { e: "💀" }) }); // the limit is per connection
  await a.next("react");
  const h = (await b.req("join", { e2ee: 1, roomId: snap.roomId, cid: b.cid })).history;
  assert.ok(!h.some((x) => x.kind === "react"), "reactions are not kept");
  ok("encrypted reactions: relayed to others, size-checked, rate limited (6 per 3 s), not in history");
}

// ---- voice: A joins first, B joins and gets A as a peer to call; signaling is encrypted
{
  const va = await a.req("voiceJoin", {});
  assert.deepEqual(va.peers, []);
  assert.ok(va.iceServers.length >= 1);
  const vb = await b.req("voiceJoin", {});
  assert.deepEqual(vb.peers, [a.pid]);
  const ve = await a.next("voice", (m) => m.data.event === "join");
  assert.deepEqual(ve.data, { event: "join", id: b.pid });
  assert.ok(await a.next("members", (m) => m.data.members.every((x) => x.inVoice)));
  ok("voice join + peer list (pids) + inVoice flags");

  await assert.rejects(b.req("signal", { to: a.pid, payload: { sdp: { type: "offer", sdp: "v=0" } } }), /Bad signal/, "plaintext SDP refused");
  const offer = { sdp: { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 203.0.113.7\r\n" } };
  await b.req("signal", { to: a.pid, ct: await seal(KEY, snap.roomId, "signal>" + a.pid, b.pid, offer) });
  const sig = await a.next("signal");
  assert.deepEqual(Object.keys(sig.data).sort(), ["ct", "from"]);
  assert.equal(sig.data.from, b.pid);
  assert.deepEqual(await open(KEY, snap.roomId, "signal>" + a.pid, sig.data.from, sig.data.ct), offer);
  await a.req("signal", { to: b.pid, ct: await seal(KEY, snap.roomId, "signal>" + b.pid, a.pid, { ice: { candidate: "candidate:1 1 udp 1 198.51.100.4 5000 typ srflx" } }) });
  assert.ok(CT_RE.test((await b.next("signal")).data.ct));
  await assert.rejects(a.req("signal", { to: "ghost", ct: await sealAs(a, "signal>ghost", {}) }), /Peer/);
  await assert.rejects(a.req("signal", { to: a.pid, ct: await sealAs(a, "signal>x", {}) }), /Peer/);
  ok("WebRTC signaling relay: encrypted offer + ICE only (no IPs for the server)");

  await b.req("voiceState", { muted: true, speaking: false });
  const vs = await a.next("voice", (m) => m.data.event === "state");
  assert.deepEqual(vs.data, { event: "state", id: b.pid, muted: true, speaking: false });
  ok("mute/speaking state");

  await b.req("voiceLeave", {});
  assert.equal((await a.next("voice", (m) => m.data.event === "leave")).data.id, b.pid);
  ok("voice leave");
}

// ---- seats: cid is a private reconnect secret, pid gets you nothing
{
  const host = await member("host2", { key: KEY, create: { videoId: "81234567", playing: false, position: 0, at: Date.now() } });
  const guest = await member("guest2", { key: KEY, room: host.room });
  await host.next("members");
  // someone who saw the host's pid (it's in every member list) tries to use it
  const thief = client("thief");
  await thief.ready;
  await thief.next("welcome");
  await assert.rejects(thief.req("join", { e2ee: 1, roomId: host.room, cid: host.pid }), /Bad client id/);
  const t1 = await thief.req("join", { e2ee: 1, roomId: host.room, cid: newCid(), pid: host.pid, id: host.pid, you: host.pid, hostId: host.pid });
  assert.notEqual(t1.you, host.pid);
  assert.equal(t1.hostId, host.pid, "host unchanged");
  assert.equal(t1.returning, false);
  assert.equal(t1.members.length, 3, "the host keeps their seat");
  await assert.rejects(thief.req("end", {}), /Only the host/);
  await assert.rejects(thief.req("settings", { hostOnly: true }), /host/);
  // a guessed cid is just a new seat too
  const t2 = await member("thief2", { key: KEY, room: host.room });
  assert.ok(![host.pid, guest.pid, t1.you].includes(t2.pid));
  assert.equal(t2.snap.hostId, host.pid);
  // the guest's own cid gets the guest's seat back (same pid), and the old connection loses it
  const g2 = await member("guest2b", { key: KEY, room: host.room, cid: guest.cid });
  assert.equal(g2.pid, guest.pid);
  assert.equal(g2.snap.returning, true);
  await assert.rejects(guest.req("chat", { ct: await sealAs(guest, "chat", { t: "text", text: "x" }) }), /Not in a party/);
  // the host's cid always brings the host role back
  host.close();
  await sleep(200);
  const h2 = await member("host2b", { key: KEY, room: host.room, cid: host.cid });
  assert.equal(h2.pid, host.pid);
  assert.equal(h2.snap.hostId, host.pid);
  await h2.req("end", {});
  for (const c of [guest, thief, t2, g2, h2]) c.close();
  ok("seat hijack: someone's pid or a guessed id never gets their seat or host role; own cid does");
}

// ---- invite page: no names (the server has none), the key is read client-side only
{
  const page = await fetch(`${HTTP}/j/${snap.roomId}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /You're invited to a watch party/);
  assert.ok(!html.includes("Chirag") && !html.includes(MARK));
  assert.ok(html.includes(`data-watch="https://www.netflix.com/watch/81234567?npParty=${snap.roomId}"`));
  assert.ok(html.includes(`data-kc="${snap.kc}"`));
  assert.ok(html.includes(`data-hpid="${a.pid}"`));
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /connect-src 'none'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", enc.encode(script))).toString("base64");
  assert.ok(csp.includes(`'sha256-${hash}'`), "the CSP pins exactly the page's script");
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|new Image|\.src\s*=/.test(script), "the page's script never sends anything");
  assert.match(script, /location\.hash/);
  // the page decrypts the host's name with the key from the fragment (same AAD as the extension)
  const hostCt = html.match(/data-host="([A-Za-z0-9_-]+)"/)[1];
  assert.equal((await open(KEY, snap.roomId, "profile", a.pid, hostCt)).name, "Chirag");
  const dl = await fetch(`${HTTP}/j/${snap.roomId}/netparty.zip`);
  console.log("  (extension download: HTTP " + dl.status + ")");
  assert.ok(dl.status === 200 || dl.status === 404); // 404 when the server has no zip configured
  if (dl.status === 200) assert.ok((await dl.arrayBuffer()).byteLength > 5000);
  const gone = await fetch(`${HTTP}/j/zzzzzzzz`);
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /ended/);
  assert.equal((await fetch(`${HTTP}/j/zzzzzzzz/netparty.zip`)).status, 404);
  ok("invite page (no names server-side, key only via #fragment, strict CSP, ended party, gated download)");
}

{
  // YouTube party: invite page names YouTube and links to the watch page
  const y = await member("y", { key: genKey(), create: { videoId: "yt:dQw4w9WgXcQ", playing: false, position: 0, at: Date.now() } });
  const html = await (await fetch(`${HTTP}/j/${y.room}`)).text();
  assert.match(html, /Join on YouTube/);
  assert.ok(!/Netflix/.test(html));
  assert.ok(html.includes(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;npParty=${y.room}`));
  await y.req("end", {});
  y.close();
  ok("YouTube invite page");
}

{
  // GIF search proxy: without a key it says so (503); with one it normalizes KLIPY's answer
  const r0 = await fetch(`${HTTP}/api/gifs/trending`, { headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
  const j0 = await r0.json();
  if (r0.status === 503) assert.equal(j0.error, "gifs_unavailable");
  else assert.ok(r0.status === 200 && Array.isArray(j0.results), JSON.stringify(j0));
  assert.equal(r0.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
  const evil = await fetch(`${HTTP}/api/gifs/trending`, { headers: { origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(`${HTTP}/api/gifs/search`)).status, 400);
  assert.equal((await fetch(`${HTTP}/api/gifs/nope`)).status, 404);
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
    const logs = [];
    const orig = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...x) => logs.push(x.join(" "));
    const r1 = await fetch(`${HTTP}/api/gifs/search?q=${encodeURIComponent("Stranger Things")}&pos=`);
    [console.log, console.error, console.warn] = orig;
    const j1 = await r1.json();
    assert.equal(r1.status, 200);
    assert.equal(lastQ.get("q"), "Stranger Things");
    assert.equal(lastQ.get("key"), "test-key");
    assert.equal(lastQ.get("contentfilter"), "medium");
    assert.deepEqual([...lastQ.keys()].sort(), ["client_key", "contentfilter", "key", "limit", "media_filter", "q"], "only the query goes to KLIPY (no party, no names)");
    assert.ok(!logs.some((l) => l.includes("Stranger")), "GIF searches are not logged");
    assert.equal(j1.next, "abc=");
    assert.deepEqual(j1.results.map((x) => x.id), ["1", "3"]); // off-host media dropped
    assert.deepEqual(j1.results[0], { id: "1", url: "https://static.klipy.com/ii/x/1.gif", preview: "https://static.klipy.com/ii/x/1.gif", w: 220, h: 124, title: "t1" });
    assert.ok(!JSON.stringify(j1).includes("test-key"));
    lastQ = null;
    await fetch(`${HTTP}/api/gifs/search?q=${encodeURIComponent("Stranger Things")}`);
    assert.equal(lastQ, null, "second identical search is served from cache");
    const r2 = await fetch(`${HTTP}/api/gifs/trending?pos=abc%3D`);
    assert.equal(r2.status, 200);
    assert.equal(lastQ.get("pos"), "abc=");
    delete process.env.KLIPY_KEY;
    delete process.env.KLIPY_BASE;
    mock.close();
  }
  ok("GIF proxy endpoints (" + (r0.status === 503 ? "no key: 503 gifs_unavailable" : "live") + ")");
}

{
  // page reload: same cid rejoins silently, same pid, keeps host, gets (encrypted) chat history back
  const key = genKey();
  const c = await member("c", { key, create: { videoId: "81234567", playing: true, position: 1000, at: Date.now() } });
  const d = await member("d", { key, room: c.room });
  await c.req("chat", { ct: await sealAs(c, "chat", { t: "text", text: "before reload" }) });
  await d.next("chat");
  c.close();
  await sleep(300);
  const c2 = await member("c2", { key, room: c.room, cid: c.cid });
  const back = c2.snap;
  assert.equal(back.returning, true);
  assert.equal(back.you, c.pid);
  assert.equal(back.hostId, c.pid);
  assert.equal(back.members.length, 2);
  const line = back.history.find((h) => h.kind === "chat");
  assert.equal(line.from, c.pid, "own old messages are still ours");
  assert.equal((await open(key, c.room, "chat", line.from, line.ct)).text, "before reload");
  await sleep(400);
  const spam = await d.next("system", (m) => m.data.id === c.pid).catch(() => null);
  assert.equal(spam, null, "unexpected: " + JSON.stringify(spam?.data));
  ok("reload keeps seat (same pid), host role and chat history (no left/joined spam)");
  c2.close();
  d.close();
}

{
  // host ends the party: everyone is told, the code stops working
  const key = genKey();
  const e = await member("e", { key, create: { videoId: "81234567", playing: false, position: 0, at: Date.now() } });
  const f = await member("f", { key, room: e.room });
  await assert.rejects(f.req("end", {}), /Only the host/);
  await e.req("end", {});
  const ended = await f.next("ended");
  assert.deepEqual(ended.data, { by: e.pid });
  await assert.rejects(f.req("join", { e2ee: 1, roomId: e.room, cid: f.cid }), /not found/);
  await assert.rejects(f.req("chat", { ct: await sealAs(f, "chat", { t: "text", text: "hi" }) }), /Not in a party/);
  assert.equal((await fetch(`${HTTP}/j/${e.room}`)).status, 404);
  ok("host ends party for everyone");
  e.close();
  f.close();
}

{
  // chat rate limit
  const key = genKey();
  const r = await member("r", { key, create: { videoId: "81234567", playing: false, position: 0, at: Date.now() } });
  const ct = await sealAs(r, "chat", { t: "text", text: "spam" });
  for (let i = 0; i < 20; i++) await r.req("chat", { ct });
  await assert.rejects(r.req("chat", { ct }), /Slow down/);
  await r.req("end", {});
  r.close();
  ok("chat rate limit (20 per 10 s)");
}

if (!process.env.TARGET) {
  // server restart: a party saved to the store comes back with state, host, seats and
  // (encrypted) chat; nothing readable is ever stored
  const { createHub, PURGE_AGE_MS } = await import("./core.js");
  const disk = new Map();
  const store = {
    get: async (k) => structuredClone(disk.get(k) ?? null),
    put: async (k, v) => disk.set(k, structuredClone(v)),
    del: async (k) => disk.delete(k),
    list: async () => [...disk].map(([k, v]) => [k, structuredClone(v)]),
  };
  const fake = (hub) => {
    const inbox = [];
    let seq = 0;
    const waits = new Map();
    const conn = hub.connect((raw) => {
      allFrames.push({ label: "fake", text: raw });
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
  const key = genKey();
  const hostCid = newCid(), guestCid = newCid();
  const hub1 = createHub({ store });
  const h = fake(hub1);
  const s1 = await h.req("create", { e2ee: 1, cid: hostCid, kc: await check(key), videoId: "81234567", playing: true, position: 42000, at: Date.now() });
  const room = s1.roomId, hp = s1.you;
  await h.req("profile", { ct: await seal(key, room, "profile", hp, { name: "Hostname-" + MARK, avatar: "🦊" }) });
  await h.req("chat", { ct: await seal(key, room, "chat", hp, { t: "text", text: "survive this " + MARK }) });
  await h.req("chat", { ct: await seal(key, room, "chat", hp, { t: "gif", url: "https://static.klipy.com/ii/x/" + MARK + ".gif" }) });
  await sleep(450);
  const dump = JSON.stringify([...disk]);
  assert.ok(disk.size === 1 && dump.includes(room));
  assert.ok(!dump.includes(MARK) && !dump.includes("Hostname") && !dump.includes("survive") && !dump.includes("klipy") && !dump.includes("🦊"), "storage holds no plaintext");
  const saved = disk.get(room);
  assert.equal(saved.e2ee, true);
  for (const x of saved.history) if (x.kind === "chat") assert.ok(CT_RE.test(x.ct) && Object.keys(x).length === 4);
  ok("stored party is ciphertext only (no names, messages, GIF links or emoji)");

  const hub2 = createHub({ store }); // "restart": nothing in memory
  const g = fake(hub2);
  const gs = await g.req("join", { e2ee: 1, roomId: room, cid: guestCid });
  assert.equal(gs.state.position, 42000);
  const line = gs.history.find((x) => x.kind === "chat");
  assert.equal((await open(key, room, "chat", line.from, line.ct)).text, "survive this " + MARK);
  assert.equal((await open(key, room, "profile", hp, gs.profiles[hp])).name, "Hostname-" + MARK);
  const h2 = fake(hub2);
  const hs = await h2.req("join", { e2ee: 1, roomId: room, cid: hostCid });
  assert.equal(hs.you, hp, "same pid after a restart");
  assert.equal(hs.hostId, hp); // creator gets host back
  assert.ok(await hub2.findRoom(room));
  await h2.req("end", {});
  await sleep(50);
  assert.equal(disk.size, 0);
  ok("party survives a server restart (store: same pids, host, encrypted history) and is deleted when ended");

  // a pre-1.7 (plaintext) party left in storage: refused with a clear message and deleted
  disk.set("old12345", { id: "old12345", state: { playing: false, position: 0, at: Date.now(), videoId: "1" }, hostCid: "x", history: [{ kind: "chat", text: "old" }], savedAt: Date.now() });
  const hub3 = createHub({ store });
  const o = fake(hub3);
  await assert.rejects(o.req("join", { e2ee: 1, roomId: "old12345", cid: newCid() }), /older NetParty/);
  await sleep(20);
  assert.equal(disk.has("old12345"), false);
  // idle saved parties are purged by the periodic maintenance; running ones are kept
  disk.set("stale123", { id: "stale123", e2ee: true, savedAt: Date.now() - PURGE_AGE_MS - 1000, history: [] });
  disk.set("fresh123", { id: "fresh123", e2ee: true, savedAt: Date.now() - 60_000, history: [] });
  disk.set("legacy12", { id: "legacy12", savedAt: Date.now(), history: [] });
  await hub3.maintain();
  assert.deepEqual([...disk.keys()].sort(), ["fresh123"]);
  assert.ok(PURGE_AGE_MS <= 6 * 3600_000 - 15 * 60_000, "purged before 6 hours, with a sweep every 15 minutes");
  ok("pre-1.7 saved parties refused + deleted; idle parties purged (≤ 6 h)");
}

// host leaves -> host passes to B
a.close();
const sysLeft = await b.next("system", (m) => m.data.event === "leave" && m.data.id === a.pid, 20000);
const after = await b.next("members", (m) => m.data.members.length === 1, 20000);
assert.equal(after.data.hostId, b.pid);
ok("host handoff on disconnect (leave event for " + sysLeft.data.id + ")");

// ---- leak audit over everything every client received
{
  const secrets = [a.cid, b.cid];
  for (const f of allFrames) {
    for (const s of secrets) assert.ok(!f.text.includes(s), "a cid was sent to a client: " + f.text.slice(0, 200));
    assert.ok(!f.text.includes(KEY), "the room key reached the server");
    assert.ok(!f.text.includes(MARK), "plaintext marker in a server message: " + f.text.slice(0, 200));
  }
  const plain = allFrames.filter((f) => /"(name|byName|text|emoji|avatar|payload|cid)":/.test(f.text));
  assert.deepEqual(plain.map((f) => f.text.slice(0, 120)), [], "no plaintext fields in any server message");
  ok(`leak audit: ${allFrames.length} server frames, no cid, key, names, text, emoji or SDP in any of them`);
}

b.close();
const res = await fetch(HTTP + "/health").then((r) => r.json());
assert.equal(res.ok, true);
ok("health endpoint");

console.log("\nAll server tests passed.");
server?.close();
process.exit(0);
