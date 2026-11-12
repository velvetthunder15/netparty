// Unit tests for the anonymous daily totals (stats.js) and the hub's stats events (core.js).
import assert from "node:assert/strict";
import { createStats, statsResponse, istDay, nextIstMidnight, serviceOf, RETENTION_DAYS } from "./stats.js";
import { createHub } from "./core.js";

// in-memory stand-in for Durable Object storage (same calls stats.js makes)
function memStorage() {
  const m = new Map();
  const sorted = () => [...m.keys()].sort();
  return {
    m,
    async get(k) {
      return m.has(k) ? structuredClone(m.get(k)) : undefined;
    },
    async put(k, v) {
      m.set(k, structuredClone(v));
    },
    async delete(k) {
      if (Array.isArray(k)) {
        assert.ok(k.length <= 128, "delete batches are at most 128 keys");
        let n = 0;
        for (const x of k) n += m.delete(x) ? 1 : 0;
        return n;
      }
      return m.delete(k);
    },
    async list({ prefix = "", limit = Infinity, start, end } = {}) {
      const out = new Map();
      for (const k of sorted()) {
        if (!k.startsWith(prefix) || (start && k < start) || (end && k >= end)) continue;
        if (out.size >= limit) break;
        out.set(k, structuredClone(m.get(k)));
      }
      return out;
    },
  };
}

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// 2026-11-10 23:59:00 IST = 2026-11-10 18:29:00 UTC
const T0 = Date.parse("2026-11-10T18:29:00Z");

test("IST day boundaries", () => {
  assert.equal(istDay(Date.parse("2026-11-10T18:29:59Z")), "2026-11-10");
  assert.equal(istDay(Date.parse("2026-11-10T18:30:00Z")), "2026-11-11");
  assert.equal(nextIstMidnight(T0), Date.parse("2026-11-10T18:30:00Z"));
  assert.equal(nextIstMidnight(Date.parse("2026-11-10T18:30:00Z")), Date.parse("2026-11-11T18:30:00Z"));
});

test("service from video id", () => {
  assert.equal(serviceOf("81234567"), "netflix");
  assert.equal(serviceOf("yt:dQw4w9WgXcQ"), "youtube");
  assert.equal(serviceOf("pv:www.primevideo.com/detail/0ABCDEF"), "prime");
  assert.equal(serviceOf("hs:/in/shows/x/1234567/watch"), "hotstar");
  assert.equal(serviceOf("hm:x"), "max");
  assert.equal(serviceOf("cr:GABCDEF"), "crunchyroll");
  assert.equal(serviceOf("sl:/shows/x-12345"), "sonyliv");
  // 2.4 and 2.5
  assert.equal(serviceOf("hu:5f1e6a2c-3b4d-4e5f-8a9b-0c1d2e3f4a5b"), "hulu");
  assert.equal(serviceOf("tb:movies/605225"), "tubi");
  assert.equal(serviceOf("yl:jfKfPfyJRdk"), "youtube");
  assert.equal(serviceOf("tw:caseoh_"), "twitch");
  assert.equal(serviceOf("kk:westcol"), "kick");
  assert.equal(serviceOf("rl:v6abc12-show"), "rumble");
  assert.equal(serviceOf("rb:v6abc12-show"), "rumble");
  assert.equal(serviceOf("av:AAAAAAAAAAAAAAAA"), "any-video");
  assert.equal(serviceOf(null), "unknown");
});

test("dedupe of the same IP + browser, distinct others, peak online", async () => {
  const kv = memStorage();
  let t = T0 - 3600_000;
  const s = createStats({ storage: kv, now: () => t });
  const a1 = s.connect("1.2.3.4", "UA-A");
  const a2 = s.connect("1.2.3.4", "UA-A"); // second tab, same person
  const b = s.connect("1.2.3.4", "UA-B"); // same IP, other browser
  const c = s.connect("5.6.7.8", "UA-A");
  await Promise.all([a1.ready, a2.ready, b.ready, c.ready]);
  assert.deepEqual(s.live(), { peopleConnected: 3, connections: 4 });
  a1.close();
  a1.close(); // idempotent
  assert.deepEqual(s.live(), { peopleConnected: 3, connections: 3 });
  a2.close();
  b.close();
  const again = s.connect("1.2.3.4", "UA-A"); // comes back later the same day
  await again.ready;
  const r = (await s.report()).days[0];
  assert.equal(r.day, "2026-11-10");
  assert.equal(r.people, 3);
  assert.equal(r.peakOnline, 3);
});

test("rollover across IST midnight: new salt, old salt and hashes deleted, totals kept", async () => {
  const kv = memStorage();
  let t = T0;
  let tempAt = null;
  const s = createStats({ storage: kv, now: () => t, onTemp: (at) => (tempAt = at) });
  await s.connect("9.9.9.9", "UA").ready;
  await s.partyStarted("81234567", 1);
  await s.joined(2);
  assert.equal(tempAt, Date.parse("2026-11-10T18:30:00Z"), "asks for a cleanup at midnight IST");
  const salt1 = await kv.get("stats:salt:2026-11-10");
  assert.ok(salt1);
  assert.equal([...kv.m.keys()].filter((k) => k.startsWith("stats:seen:2026-11-10:")).length, 1);

  t = Date.parse("2026-11-10T18:30:01Z"); // 00:00:01 IST on the 11th
  await s.connect("9.9.9.9", "UA").ready; // same person, new day: counted again
  assert.equal(await kv.get("stats:salt:2026-11-10"), undefined, "yesterday's salt is gone");
  assert.equal([...kv.m.keys()].filter((k) => k.startsWith("stats:seen:2026-11-10")).length, 0, "yesterday's hashes are gone");
  const salt2 = await kv.get("stats:salt:2026-11-11");
  assert.ok(salt2 && salt2 !== salt1, "a fresh random salt for the new day");
  const rep = await s.report();
  assert.equal(rep.today, "2026-11-11");
  assert.deepEqual(rep.days.map((d) => [d.day, d.people, d.parties, d.joins, d.peakParty]), [
    ["2026-11-11", 1, 0, 0, 0],
    ["2026-11-10", 1, 1, 1, 2],
  ]);
  assert.deepEqual(rep.days[1].platforms, { netflix: 1 });
});

test("alarm maintain closes a finished day with nobody connecting", async () => {
  const kv = memStorage();
  let t = T0;
  const s = createStats({ storage: kv, now: () => t });
  await s.connect("1.1.1.1", "UA").ready;
  assert.equal(await s.maintain(), Date.parse("2026-11-10T18:30:00Z"));
  t = Date.parse("2026-11-10T18:30:05Z");
  assert.equal(await s.maintain(), null, "nothing temporary left");
  assert.deepEqual([...kv.m.keys()], ["stats:day:2026-11-10"]);
});

test("restart: the same day's salt and hashes survive, stale ones are cleaned", async () => {
  const kv = memStorage();
  let t = T0 - 7200_000;
  const s1 = createStats({ storage: kv, now: () => t });
  await s1.connect("2.2.2.2", "UA").ready;
  const s2 = createStats({ storage: kv, now: () => t }); // Durable Object restarted
  await s2.connect("2.2.2.2", "UA").ready;
  await s2.connect("3.3.3.3", "UA").ready;
  assert.equal((await s2.report()).days[0].people, 2, "no double count after restart");
  // restart after midnight with leftovers from the previous day
  t = Date.parse("2026-11-11T05:00:00Z");
  const s3 = createStats({ storage: kv, now: () => t });
  await s3.partyStarted("yt:dQw4w9WgXcQ");
  assert.ok(![...kv.m.keys()].some((k) => k.includes("2026-11-10") && !k.startsWith("stats:day:")));
});

test("retention: totals older than 120 days are deleted", async () => {
  const kv = memStorage();
  for (let i = 0; i < 130; i++) {
    const d = new Date(Date.parse("2026-11-10T00:00:00Z") - i * 86400_000).toISOString().slice(0, 10);
    await kv.put("stats:day:" + d, { people: 1, parties: 0, joins: 0, peakOnline: 1, peakParty: 0, platforms: {} });
  }
  const s = createStats({ storage: kv, now: () => Date.parse("2026-11-11T06:00:00Z") });
  await s.maintain();
  const days = (await s.report()).days.map((d) => d.day);
  assert.equal(days.length, RETENTION_DAYS - 1, "today (no record yet) + 119 previous days kept");
  assert.equal(days.at(-1), "2026-07-15");
  assert.ok(!days.includes("2026-07-14"));
});

test("hub events: party start, new joins, reconnects not counted, platform", async () => {
  const kv = memStorage();
  const s = createStats({ storage: kv, now: () => T0 - 60_000 });
  const hub = createHub({ events: { partyStarted: (v, n) => s.partyStarted(v, n), joined: (n) => s.joined(n) } });
  const out = [];
  const mk = () => {
    const box = [];
    const c = hub.connect((m) => box.push(JSON.parse(m)));
    return { c, box, req: (type, data) => new Promise((r) => {
      const id = Math.random();
      c.message(JSON.stringify({ type, reqId: id, data }));
      const tick = () => { const f = box.find((x) => x.reqId === id); f ? r(f) : setTimeout(tick, 1); };
      tick();
    }) };
  };
  const kc = "A".repeat(60);
  const host = mk();
  const cr = await host.req("create", { e2ee: 1, cid: "a".repeat(32), kc, videoId: "yt:dQw4w9WgXcQ", playing: false, position: 0 });
  const roomId = cr.data.roomId;
  const g = mk();
  await g.req("join", { e2ee: 1, roomId, cid: "b".repeat(32) });
  await g.req("join", { e2ee: 1, roomId, cid: "b".repeat(32) }); // same connection asking again
  const g2 = mk(); // same tab reconnecting
  await g2.req("join", { e2ee: 1, roomId, cid: "b".repeat(32) });
  const h = mk();
  await h.req("join", { e2ee: 1, roomId, cid: "c".repeat(32) });
  await s.flush();
  const d = (await s.report()).days[0];
  assert.equal(d.parties, 1);
  assert.equal(d.joins, 2);
  assert.equal(d.peakParty, 3);
  assert.deepEqual(d.platforms, { youtube: 1 });
  out.push(d);
});

test("no personal data in storage", async () => {
  const kv = memStorage();
  const s = createStats({ storage: kv, now: () => T0 - 1000 });
  const ip = "203.0.113.77", ua = "Mozilla/5.0 (X11; Linux) Chrome/130 SecretBrowser";
  await s.connect(ip, ua).ready;
  await s.partyStarted("yt:dQw4w9WgXcQ", 1);
  await s.partyStarted("81234567", 1);
  const dump = JSON.stringify([...kv.m.entries()]);
  for (const bad of [ip, "203.0.113", "SecretBrowser", "Mozilla", "dQw4w9WgXcQ", "81234567"]) assert.ok(!dump.includes(bad), "storage must not contain " + bad);
  for (const k of kv.m.keys()) assert.match(k, /^stats:(day:\d{4}-\d\d-\d\d|salt:\d{4}-\d\d-\d\d|seen:\d{4}-\d\d-\d\d:[A-Za-z0-9_-]{22})$/);
  const rec = await kv.get("stats:day:2026-11-10");
  assert.deepEqual(Object.keys(rec).sort(), ["joins", "parties", "peakOnline", "peakParty", "people", "platforms"]);
});

test("auth: missing or wrong key is a plain 404; right key works (query or bearer)", async () => {
  const kv = memStorage();
  const s = createStats({ storage: kv, now: () => T0 - 1000 });
  await s.connect("1.1.1.1", "UA").ready;
  const env = { STATS_TOKEN: "k_" + "x".repeat(41) };
  const live = () => ({ roomsOpen: 0, partiesActive: 0 });
  const get = (path, headers = {}) => statsResponse(new Request("https://netparty.tech" + path, { headers }), env, s, live);
  for (const p of ["/stats", "/stats.json", "/stats?key=", "/stats?key=wrong", "/stats.json?key=" + env.STATS_TOKEN + "x"]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.equal(await r.text(), "Not found.\n");
  }
  assert.equal((await get("/stats.json", { Authorization: "Bearer nope" })).status, 404);
  assert.equal((await statsResponse(new Request("https://x/stats?key=a"), {}, s, live)).status, 404, "no secret configured: 404");
  const ok = await get("/stats.json?key=" + env.STATS_TOKEN);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.match(ok.headers.get("x-robots-tag"), /noindex/);
  const j = await ok.json();
  assert.equal(j.days[0].people, 1);
  assert.equal(j.live.peopleConnected, 1);
  const html = await get("/stats", { Authorization: "Bearer " + env.STATS_TOKEN });
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /text\/html/);
  const body = await html.text();
  assert.match(body, /NetParty stats/);
  assert.ok(!body.includes(env.STATS_TOKEN), "the page never echoes the key");
  assert.ok(!/<script|https?:\/\/(?!www\.w3)/.test(body), "no scripts or external assets");
});

for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log("ok  ", name);
  } catch (e) {
    console.log("FAIL", name, "\n", e);
    process.exitCode = 1;
  }
}
console.log(`\nstats: ${passed}/${tests.length} passed`);
