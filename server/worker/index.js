// NetParty sync server on Cloudflare Workers. All WebSocket connections go to one
// Durable Object ("hub"), which runs the same room logic as the Node server.
import { createHub, defaultIceServers } from "../core.js";

export class PartyHub {
  constructor(state, env) {
    this.state = state;
    this.hub = createHub({ iceServers: defaultIceServers(env) });
  }

  async fetch(request) {
    const url = new URL(request.url);
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

export default {
  async fetch(request, env) {
    const stub = env.HUB.get(env.HUB.idFromName("global"));
    return stub.fetch(request);
  },
};
