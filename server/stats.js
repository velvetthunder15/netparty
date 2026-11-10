// NetParty usage stats: anonymous daily totals, nothing per person.
//
// Days follow India time (Asia/Kolkata, UTC+05:30, no daylight saving).
// What is counted per day: distinct people who connected, parties started, party joins, the most
// people connected at once, the biggest party, and how many parties started on each service (read
// from the unencrypted video id prefix the server already gets for sync; nothing new from clients).
//
// "Distinct people" without storing anyone: each connection is reduced to
// HMAC-SHA256(daily salt, IP address + user agent), cut to 128 bits. The salt is random, made fresh
// for each day, and the salt and that day's hashes are deleted as soon as the day is over, so
// yesterday's hashes can't be recomputed or linked to today's. Only the totals are kept, for
// RETENTION_DAYS. Never stored: IP addresses, user agents, names, chat, room codes, video ids, URLs.
//
// storage: the Durable Object storage API (get, put, delete(key | keys[]), list({ prefix, limit, start })).
export const RETENTION_DAYS = 120;
export const SEEN_CAP = 50_000; // most distinct people a day can dedupe (bounds that day's temporary storage)
const IST_MS = 5.5 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
export const SERVICES = ["netflix", "prime", "hotstar", "youtube", "max", "crunchyroll", "sonyliv", "any-video"];

const K = {
  day: (d) => "stats:day:" + d, // { people, parties, joins, peakOnline, peakParty, platforms, capped? } totals only
  salt: (d) => "stats:salt:" + d, // temporary, deleted at the end of day d
  seen: (d) => "stats:seen:" + d + ":", // temporary, deleted at the end of day d
};

export const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
// the first millisecond of the next India-time day after ms
export const nextIstMidnight = (ms) => Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS + DAY_MS - IST_MS;
const dayMinus = (day, n) => new Date(Date.parse(day + "T00:00:00Z") - n * DAY_MS).toISOString().slice(0, 10);

// which service a party's video id belongs to (same shapes as validVideoId in core.js)
export function serviceOf(videoId) {
  const v = typeof videoId === "string" ? videoId : "";
  if (!v) return "unknown";
  if (/^\d{1,12}$/.test(v)) return "netflix";
  const p = { "pv:": "prime", "hs:": "hotstar", "yt:": "youtube", "hm:": "max", "cr:": "crunchyroll", "sl:": "sonyliv", "av:": "any-video" }[v.slice(0, 3)];
  return p || "unknown";
}

const b64u = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const emptyDay = () => ({ people: 0, parties: 0, joins: 0, peakOnline: 0, peakParty: 0, platforms: {} });

async function deletePrefix(storage, prefix) {
  for (;;) {
    const keys = [...(await storage.list({ prefix, limit: 128 })).keys()];
    if (!keys.length) return;
    await storage.delete(keys);
  }
}

export function createStats({ storage, now = () => Date.now(), onTemp = () => {} } = {}) {
  let cur = null; // { day, rec, key (CryptoKey for the salt), seen (Set, cache) }
  let chain = Promise.resolve();
  let started = false;
  const online = new Map(); // hash -> open connections (memory only, for "connected now")
  let connections = 0;
  // every change runs in order, so concurrent connections can't race on the counters
  const serial = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  const saveRec = () => storage.put(K.day(cur.day), cur.rec);

  // close any finished day: delete its salt and hashes (its totals stay), and drop totals past retention
  async function closeOldDays(today) {
    const salts = await storage.list({ prefix: "stats:salt:" });
    for (const k of salts.keys()) {
      const d = k.slice("stats:salt:".length);
      if (d === today) continue;
      await deletePrefix(storage, K.seen(d));
      await storage.delete(k);
    }
    // hashes without a salt (an interrupted cleanup)
    const orphan = await storage.list({ prefix: "stats:seen:", limit: 1 });
    for (const k of orphan.keys()) {
      const d = k.slice("stats:seen:".length, "stats:seen:".length + 10);
      if (d !== today) await deletePrefix(storage, K.seen(d));
    }
    const cutoff = dayMinus(today, RETENTION_DAYS - 1); // keep today and the 119 days before it
    const old = [...(await storage.list({ prefix: "stats:day:", end: K.day(cutoff) })).keys()].filter((k) => k < K.day(cutoff));
    for (let i = 0; i < old.length; i += 128) await storage.delete(old.slice(i, i + 128));
  }

  async function today() {
    const day = istDay(now());
    if (cur && cur.day === day) return cur;
    if (cur || !started) await closeOldDays(day);
    started = true;
    let salt = await storage.get(K.salt(day));
    if (!salt) {
      salt = b64u(crypto.getRandomValues(new Uint8Array(32)));
      await storage.put(K.salt(day), salt);
    }
    const key = await crypto.subtle.importKey("raw", unb64u(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const rec = { ...emptyDay(), ...((await storage.get(K.day(day))) || {}) };
    rec.peakOnline = Math.max(rec.peakOnline, online.size);
    cur = { day, rec, key, seen: new Set() };
    onTemp(nextIstMidnight(now()));
    return cur;
  }

  // a WebSocket opened: returns a handle whose close() is called when it closes
  function connect(ip, ua) {
    let hash = null;
    let closed = false;
    connections++;
    const ready = serial(async () => {
      const c = await today();
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", c.key, new TextEncoder().encode(String(ip || "") + "\n" + String(ua || ""))));
      hash = b64u(mac.subarray(0, 16));
      if (!closed) online.set(hash, (online.get(hash) || 0) + 1);
      if (!c.seen.has(hash)) {
        const k = K.seen(c.day) + hash;
        if (!(await storage.get(k))) {
          if (c.rec.people < SEEN_CAP) {
            await storage.put(k, 1);
            c.rec.people++;
          } else c.rec.capped = true;
        }
        if (c.seen.size < SEEN_CAP) c.seen.add(hash);
      }
      if (online.size > c.rec.peakOnline) c.rec.peakOnline = online.size;
      await saveRec();
    }).catch(() => {});
    return {
      ready,
      close() {
        if (closed) return;
        closed = true;
        connections--;
        if (!hash || !online.has(hash)) return;
        const n = (online.get(hash) || 1) - 1;
        if (n > 0) online.set(hash, n);
        else online.delete(hash);
      },
    };
  }

  const partyStarted = (videoId, size = 1) =>
    serial(async () => {
      const c = await today();
      const s = serviceOf(videoId);
      c.rec.parties++;
      c.rec.platforms[s] = (c.rec.platforms[s] || 0) + 1;
      if (size > c.rec.peakParty) c.rec.peakParty = size;
      await saveRec();
    }).catch(() => {});

  const joined = (size) =>
    serial(async () => {
      const c = await today();
      c.rec.joins++;
      if (size > c.rec.peakParty) c.rec.peakParty = size;
      await saveRec();
    }).catch(() => {});

  // called from the alarm: closes a finished day even when nobody connects after midnight.
  // Returns when the next cleanup is due (ms), or null when no temporary data is left.
  const maintain = () =>
    serial(async () => {
      const day = istDay(now());
      if (cur && cur.day !== day) cur = null;
      await closeOldDays(day);
      started = true;
      return (await storage.get(K.salt(day))) ? nextIstMidnight(now()) : null;
    });

  // all kept days (newest first) and today's numbers so far
  const report = () =>
    serial(async () => {
      const day = istDay(now());
      const days = [];
      for (const [k, v] of await storage.list({ prefix: "stats:day:" })) days.push({ day: k.slice("stats:day:".length), ...emptyDay(), ...v });
      days.sort((a, b) => (a.day < b.day ? 1 : -1));
      return { timezone: "Asia/Kolkata", today: day, retentionDays: RETENTION_DAYS, days };
    });

  return {
    connect,
    partyStarted,
    joined,
    maintain,
    report,
    live: () => ({ peopleConnected: online.size, connections }),
    flush: () => chain,
  };
}

// ---- /stats and /stats.json, for the owner only. Anything without the right key gets the same 404
// as any unknown path, so the pages don't reveal that they exist.
const enc = new TextEncoder();
async function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  // compare fixed-length digests so neither length nor content leaks through timing
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
export const NOT_FOUND = () =>
  new Response("Not found.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" } });

export function isStatsPath(pathname) {
  return pathname === "/stats" || pathname === "/stats.json";
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function statsHtml(data) {
  const n = (v) => Number(v || 0).toLocaleString("en-IN");
  const t = data.days.find((d) => d.day === data.today) || { people: 0, parties: 0, joins: 0, peakOnline: 0, peakParty: 0, platforms: {} };
  const svc = [...SERVICES, "unknown"];
  const rows = data.days
    .map((d) => {
      const pl = svc.filter((s) => d.platforms?.[s]).map((s) => `${esc(s)} ${n(d.platforms[s])}`).join(", ") || "-";
      return `<tr${d.day === data.today ? ' class="now"' : ""}><td>${esc(d.day)}</td><td>${n(d.people)}${d.capped ? "+" : ""}</td><td>${n(d.parties)}</td><td>${n(d.joins)}</td><td>${n(d.peakOnline)}</td><td>${n(d.peakParty)}</td><td class="pl">${pl}</td></tr>`;
    })
    .join("");
  const tile = (label, v) => `<div class="tile"><div class="v">${n(v)}</div><div class="l">${esc(label)}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NetParty stats</title><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<style>
:root{color-scheme:dark}
body{margin:0;background:#0B0A12;color:#D9D6E8;font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:40px 20px 64px}
h1{color:#fff;font-size:28px;margin:0 0 4px;letter-spacing:-.01em}h2{color:#fff;font-size:18px;margin:32px 0 10px}
.muted{color:#8E89A6;font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:20px}
.tile{background:#15121F;border:1px solid #221F33;border-radius:14px;padding:14px 16px}
.tile .v{color:#fff;font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}.tile .l{color:#B79CFF;font-size:13px}
.wrap{overflow-x:auto;border:1px solid #221F33;border-radius:14px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:9px 12px;border-bottom:1px solid #1C1929;white-space:nowrap}
th{color:#B79CFF;font-weight:600;font-size:13px;background:#15121F}th:first-child,td:first-child,td.pl,th.pl{text-align:left}
td.pl{white-space:normal;color:#A9A4C2;font-size:13px;min-width:220px}
tr.now td{background:#1A1530}tr:last-child td{border-bottom:0}
</style></head><body><main>
<h1>NetParty stats</h1>
<p class="muted">Anonymous daily totals. Days run midnight to midnight India time (IST). Today is ${esc(data.today)}. Kept for ${data.retentionDays} days.</p>
<h2>Right now</h2>
<div class="tiles">${tile("people connected", data.live.peopleConnected)}${tile("connections", data.live.connections)}${tile("parties with people in them", data.live.partiesActive)}${tile("parties open", data.live.roomsOpen)}</div>
<h2>Today so far</h2>
<div class="tiles">${tile("people", t.people)}${tile("parties started", t.parties)}${tile("joins", t.joins)}${tile("most online at once", t.peakOnline)}${tile("biggest party", t.peakParty)}</div>
<h2>By day</h2>
<div class="wrap"><table><thead><tr><th>Day (IST)</th><th>People</th><th>Parties</th><th>Joins</th><th>Peak online</th><th>Biggest party</th><th class="pl">Parties by service</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">No data yet.</td></tr>'}</tbody></table></div>
<p class="muted">People = distinct IP address and browser pairs that connected that day (a daily salted hash, deleted when the day ends). Joins = new members joining a party (reloads and reconnects not counted). Parties started on a page with no title yet show as unknown.</p>
</main></body></html>`;
}

// request: the incoming Request; env.STATS_TOKEN: the secret; stats: createStats(); live(): numbers from the hub
export async function statsResponse(request, env, stats, live) {
  const url = new URL(request.url);
  if (!isStatsPath(url.pathname) || (request.method !== "GET" && request.method !== "HEAD")) return NOT_FOUND();
  const auth = request.headers.get("Authorization") || "";
  const given = url.searchParams.get("key") || (/^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? "").trim();
  if (!(await sameSecret(given, env?.STATS_TOKEN))) return NOT_FOUND();
  const data = { ...(await stats.report()), live: { ...stats.live(), ...live() }, generatedAt: new Date().toISOString() };
  const headers = {
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  const json = url.pathname === "/stats.json";
  const body = json ? JSON.stringify(data, null, 2) : statsHtml(data);
  headers["content-type"] = json ? "application/json; charset=utf-8" : "text/html; charset=utf-8";
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}
