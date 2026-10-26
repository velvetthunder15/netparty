// NetParty sync server (Node). Room logic lives in core.js; this is the ws transport.
import http from "node:http";
import { WebSocketServer } from "ws";
import fs from "node:fs";
import { createHub, defaultIceServers, joinPage } from "./core.js";

const PORT = Number(process.env.PORT || 8787);
const hub = createHub({ iceServers: defaultIceServers(process.env) });
const rooms = hub.rooms;

// optional: serve the extension zip from invite pages (set EXTENSION_ZIP=/path/netparty.zip)
const ZIP = process.env.EXTENSION_ZIP && fs.existsSync(process.env.EXTENSION_ZIP) ? process.env.EXTENSION_ZIP : null;

const server = http.createServer(async (req, res) => {
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
