// NetParty sync server on Cloudflare Workers. All WebSocket connections go to one
// Durable Object ("hub"), which runs the same room logic as the Node server.
import { createHub, defaultIceServers, joinPage, joinPageHeaders } from "../core.js";
import { parseGifRequest, gifSearch, corsHeaders, makeLimiter, GIF_CACHE_SECONDS } from "../gifs.js";
import extensionZip from "./public/netparty-extension.zip";
// landing site (copied from the Hark-built page) bundled into the Worker
import siteIndex from "./site/index.html";
import sitePrivacy from "./site/privacy.html";
import siteCss from "./site/hark.css";
import siteHeroCss from "./site/hark-hero.css";
import siteJs from "./site/hark.js.txt";
import imgSpace from "./site/still-space.jpg";
import imgNeon from "./site/still-neon.jpg";
import imgFriends from "./site/friends.jpg";

const HTML = "text/html; charset=utf-8";
const MAINTAIN_MS = 15 * 60 * 1000;
const SITE = {
  "/": [siteIndex, HTML],
  "/index.html": [siteIndex, HTML],
  "/privacy": [sitePrivacy, HTML],
  "/hark.css": [siteCss, "text/css; charset=utf-8"],
  "/hark-hero.css": [siteHeroCss, "text/css; charset=utf-8"],
  "/hark.js": [siteJs, "text/javascript; charset=utf-8"],
  "/still-space.jpg": [imgSpace, "image/jpeg"],
  "/still-neon.jpg": [imgNeon, "image/jpeg"],
  "/friends.jpg": [imgFriends, "image/jpeg"],
};

export class PartyHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // parties are mirrored to Durable Object storage so a restart (deploys, Cloudflare
    // moving the object) doesn't lose them; clients reconnect and rejoin on their own
    // (only encrypted chat, profiles and key checks are stored; see core.js). An alarm every
    // 15 minutes deletes parties that have been idle for nearly 6 hours.
    const kv = state.storage;
    this.kv = kv;
    this.hub = createHub({
      iceServers: defaultIceServers(env),
      store: {
        get: (id) => kv.get("room:" + id),
        put: async (id, obj) => {
          await kv.put("room:" + id, obj);
          await this.ensureAlarm();
        },
        del: (id) => kv.delete("room:" + id),
        list: async () => [...(await kv.list({ prefix: "room:" }))].map(([k, v]) => [k.slice(5), v]),
      },
    });
    this.ensureAlarm().catch(() => {});
  }

  async ensureAlarm() {
    if (this.alarmSet) return;
    this.alarmSet = true;
    if ((await this.kv.getAlarm()) == null) await this.kv.setAlarm(Date.now() + MAINTAIN_MS);
  }

  async alarm() {
    this.alarmSet = false;
    await this.hub.maintain();
    const left = await this.kv.list({ prefix: "room:", limit: 1 });
    if (left.size || this.hub.rooms.size) await this.ensureAlarm();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const j = url.pathname.match(/^\/j\/([a-z0-9]{4,16})\/?$/i);
    if (j) {
      const room = await this.hub.findRoom(j[1]);
      return new Response(joinPage(room, j[1], { hasDownload: true }), {
        status: room ? 200 : 404,
        headers: await joinPageHeaders(),
      });
    }
    const live = url.pathname.match(/^\/live\/([a-z0-9]{4,16})$/i);
    if (live) {
      const room = await this.hub.findRoom(live[1]);
      return new Response(null, { status: room ? 204 : 404 });
    }
    if (url.pathname === "/health")
      return Response.json({ ok: true, rooms: this.hub.rooms.size });
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("NetParty sync server. Connect over WebSocket.\n");

    const [clientSide, serverSide] = Object.values(new WebSocketPair());
    serverSide.accept();
    const conn = this.hub.connect((s) => serverSide.send(s));
    serverSide.addEventListener("message", (e) => conn.message(e.data));
    const done = () => {
      conn.close();
      this.hub.sweep();
    };
    serverSide.addEventListener("close", done);
    serverSide.addEventListener("error", done);
    return new Response(null, { status: 101, webSocket: clientSide });
  }
}

// ---- GIF search proxy (KLIPY). Needs the Worker secret KLIPY_KEY; without it the
// endpoints answer 503 {error:"gifs_unavailable"} and the extension hides GIFs.
const gifLimit = makeLimiter({ max: 60, windowMs: 60_000 });
async function gifs(request, env, ctx, url) {
  const cors = corsHeaders(request.headers.get("Origin"));
  const json = (status, body, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...cors, ...extra } });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
  const parsed = parseGifRequest(url);
  if (parsed.error) return json(parsed.status, { error: parsed.error });
  if (!env.KLIPY_KEY) return json(503, { error: "gifs_unavailable" }, { "cache-control": "no-store" });
  const country = /^[A-Z]{2}$/.test(request.cf?.country || "") ? request.cf.country : "";
  // edge cache, keyed on the normalized query (never on the key or the caller)
  const ck = new Request(`${url.origin}/__gif-cache/${parsed.kind}?q=${encodeURIComponent(parsed.q)}&pos=${encodeURIComponent(parsed.pos)}&c=${country}`);
  const cache = caches.default;
  const hit = await cache.match(ck);
  if (hit) return json(200, await hit.json(), { "cache-control": `public, max-age=${GIF_CACHE_SECONDS}`, "x-cache": "HIT" });
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  if (!gifLimit(ip)) return json(429, { error: "rate_limited" }, { "retry-after": "60" });
  const out = await gifSearch(parsed, { key: env.KLIPY_KEY, base: env.KLIPY_BASE, country });
  if (out.status === 200)
    ctx.waitUntil(cache.put(ck, new Response(JSON.stringify(out.body), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${GIF_CACHE_SECONDS}` } })));
  return json(out.status, out.body, { "cache-control": out.status === 200 ? `public, max-age=${GIF_CACHE_SECONDS}` : "no-store" });
}

export default {
  async fetch(request, env, ctx) {
    const stub = env.HUB.get(env.HUB.idFromName("global"));
    const url = new URL(request.url);
    if (url.hostname === "www.netparty.tech")
      return Response.redirect("https://netparty.tech" + url.pathname + url.search, 301);
    const isWs = request.headers.get("Upgrade") === "websocket";
    if (!isWs && url.pathname.startsWith("/api/gifs/")) return gifs(request, env, ctx, url);
    if (!isWs && (request.method === "GET" || request.method === "HEAD")) {
      const page = SITE[url.pathname];
      if (page)
        return new Response(request.method === "HEAD" ? null : page[0], {
          headers: { "content-type": page[1], "cache-control": page[1] === HTML ? "public, max-age=300" : "public, max-age=86400" },
        });
      if (url.pathname === "/download/netparty-extension.zip")
        return new Response(extensionZip, {
          headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="netparty-extension.zip"', "cache-control": "public, max-age=300" },
        });
    }
    // invite pages also offer the zip from a live party's invite page
    const dl = url.pathname.match(/^\/j\/([a-z0-9]{4,16})\/netparty\.zip$/i);
    if (dl) {
      const live = await stub.fetch(new Request(`${url.origin}/live/${dl[1]}`));
      if (live.status !== 204) return new Response("Not available.\n", { status: 404 });
      return new Response(extensionZip, {
        headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="netparty.zip"', "cache-control": "no-store" },
      });
    }
    return stub.fetch(request);
  },
};
