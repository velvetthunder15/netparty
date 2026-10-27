// NetParty sync server (Node). Room logic lives in core.js; this is the ws transport.
import http from "node:http";
import { WebSocketServer } from "ws";
import fs from "node:fs";
import { createHub, defaultIceServers, joinPage } from "./core.js";
import { parseGifRequest, gifSearch, corsHeaders, makeLimiter, GIF_CACHE_SECONDS } from "./gifs.js";

const PORT = Number(process.env.PORT || 8787);
const hub = createHub({ iceServers: defaultIceServers(process.env) });
const rooms = hub.rooms;

// optional: serve the extension zip from invite pages (set EXTENSION_ZIP=/path/netparty.zip)
const ZIP = process.env.EXTENSION_ZIP && fs.existsSync(process.env.EXTENSION_ZIP) ? process.env.EXTENSION_ZIP : null;

// GIF search proxy: KLIPY_KEY (and KLIPY_BASE, for tests) from the environment
const gifCache = new Map(); // url -> { at, status, body }
const gifLimit = makeLimiter({ max: 60, windowMs: 60_000 });
async function gifs(req, res) {
  const url = new URL(req.url, "http://localhost");
  const cors = corsHeaders(req.headers.origin);
  const send = (status, body, extra = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...cors, ...extra });
    res.end(JSON.stringify(body));
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.method !== "GET") return send(405, { error: "method_not_allowed" });
  const parsed = parseGifRequest(url);
  if (parsed.error) return send(parsed.status, { error: parsed.error });
  if (!process.env.KLIPY_KEY) return send(503, { error: "gifs_unavailable" }, { "cache-control": "no-store" });
  const key = `${parsed.kind}|${parsed.q}|${parsed.pos}`;
  const hit = gifCache.get(key);
  if (hit && Date.now() - hit.at < GIF_CACHE_SECONDS * 1000) return send(200, hit.body, { "cache-control": `public, max-age=${GIF_CACHE_SECONDS}` });
  if (!gifLimit(req.socket.remoteAddress || "?")) return send(429, { error: "rate_limited" }, { "retry-after": "60" });
  const out = await gifSearch(parsed, { key: process.env.KLIPY_KEY, base: process.env.KLIPY_BASE });
  if (out.status === 200) {
    gifCache.set(key, { at: Date.now(), body: out.body });
    if (gifCache.size > 500) gifCache.delete(gifCache.keys().next().value);
  }
  send(out.status, out.body, { "cache-control": out.status === 200 ? `public, max-age=${GIF_CACHE_SECONDS}` : "no-store" });
}

const server = http.createServer(async (req, res) => {
  if ((req.url || "").startsWith("/api/gifs/")) return gifs(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"server_error"}');
  });
  const j = (req.url || "").match(/^\/j\/([a-z0-9]{4,16})(\/netparty\.zip)?\/?(?:\?.*)?$/i);
  if (j) {
    const room = await hub.findRoom(j[1]);
    if (j[2]) {
      if (!ZIP || !room) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("Not available.\n");
      }
      res.writeHead(200, { "content-type": "application/zip", "content-disposition": 'attachment; filename="netparty.zip"' });
      return fs.createReadStream(ZIP).pipe(res);
    }
    res.writeHead(room ? 200 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(joinPage(room, j[1], { hasDownload: !!ZIP }));
  }
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("NetParty sync server. Connect over WebSocket.\n");
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on("connection", (ws) => {
  const conn = hub.connect((s) => ws.readyState === 1 && ws.send(s));
  ws.on("message", (raw, isBinary) => conn.message(isBinary ? raw : raw.toString()));
  ws.on("close", () => conn.close());
  ws.on("pong", () => (ws._npMissed = false));
});

// Heartbeat: drop sockets that stop answering protocol pings
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._npMissed) {
      ws.terminate();
      continue;
    }
    ws._npMissed = true;
    ws.ping();
  }
}, 30_000).unref();
setInterval(() => hub.sweep(), 30_000).unref();

server.listen(PORT, () => console.log(`NetParty server listening on :${PORT}`));

export { server, wss, rooms };
