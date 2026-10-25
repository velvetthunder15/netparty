// NetParty sync server (Node). Room logic lives in core.js; this is the ws transport.
import http from "node:http";
import { WebSocketServer } from "ws";
import { createHub, defaultIceServers } from "./core.js";

const PORT = Number(process.env.PORT || 8787);
const hub = createHub({ iceServers: defaultIceServers(process.env) });
const rooms = hub.rooms;

const server = http.createServer((req, res) => {
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
