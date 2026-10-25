# NetParty — watch Netflix together

A Chrome extension + tiny sync server. Everyone in the party needs their own
Netflix account and the extension.

Features
- Playback sync: play, pause, seek, and episode changes follow the party
  (server-clock sync, 1 s seek threshold, drift correction every 3 s)
- Invite links: `https://www.netflix.com/watch/<id>?npParty=<code>` auto-joins
- Text chat overlay (works in fullscreen, doesn't trigger Netflix hotkeys)
- Voice chat: peer-to-peer WebRTC audio, mute, volume, speaking indicator
- Host-only control lock, host hand-off when the host leaves, auto-reconnect

## Quick start (2 minutes)

1. **Download** this repo: green **Code** button → **Download ZIP**, then unzip it
   (or `git clone https://github.com/velvetthunder15/netparty.git`).
2. **Install** in Chrome: open `chrome://extensions`, turn on **Developer mode**,
   click **Load unpacked**, and pick the `extension` folder.
3. **Pin** NetParty from the puzzle-piece menu.
4. **Host**: open any title on netflix.com, press play, click NetParty → **Start a party**.
   The invite link is copied to your clipboard.
5. **Invite**: send the link. Friends install the extension the same way and open the link.
   They land on the same title, in sync.
6. **Talk**: click 💬 on the player for chat; click **Join voice** and allow the mic.

No server setup needed: the extension uses the hosted server by default.

## Using NetParty

| Action | How |
| --- | --- |
| Start a party | NetParty icon → **Start a party** (link copied) |
| Join a party | Open the invite link, or icon → paste code → **Join** |
| Copy invite again | Icon → **Copy invite link** |
| Chat | 💬 button on the player; press Enter to send |
| Voice | **🎙 Join voice** in the chat panel; **Mute** to mute yourself; slider sets voice volume |
| Lock controls | Host: icon → **Only I control playback** |
| Change your name | Icon → **Settings** |
| Leave | Icon → **Leave party** |

Tips
- Everyone needs their own Netflix account on a plan that streams that title in their region.
- Use headphones on voice to avoid echo.
- If someone drifts, pressing play/pause once resyncs everyone.
- On strict college or mobile networks voice may not connect; see TURN below.

## Troubleshooting

- **Nothing happens on Netflix**: reload the Netflix tab after installing or updating the extension.
- **"Party not found"**: the host's party ended or the code is wrong; ask for a fresh link.
- **No mic prompt / no audio**: click the lock icon in the address bar → allow Microphone for netflix.com, then rejoin voice.
- **Netflix error after a seek**: reload the tab; the party rejoins automatically.

## 1. The server

A hosted server is live at `wss://netparty.chiragrasane15.workers.dev`
(Cloudflare Worker + Durable Object, free plan) and is the extension's default,
so you can skip straight to step 2.

Redeploy it: `cd server/worker && npx wrangler deploy` (needs a Cloudflare token
with Workers edit rights). Test any server: `TARGET=wss://host node server/test.js`.

Or run your own locally:

```bash
cd server
npm install
npm start            # ws://localhost:8787
npm test             # end-to-end protocol tests
```

For friends on other networks the server must be public over `wss://`. Any Node
host works (Render, Railway, Fly.io, a VPS behind Caddy/Nginx). Set `PORT` if
your host requires it. Health check: `GET /health`.

Voice uses Google STUN. On strict networks (some college/mobile networks) peers
may fail to connect; add a TURN server with env vars:
`TURN_URL=turn:host:3478 TURN_USER=... TURN_PASS=...`

## 2. Load the extension

1. Chrome → `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick the `extension` folder
3. Click the NetParty icon → **Settings** → set your name and the server URL
   (defaults to the hosted server; use `ws://localhost:8787` for a local one)

## 3. Use it

1. Open any title on netflix.com and press play
2. NetParty icon → **Start a party** (invite link is copied)
3. Friends open the link; they land on the same title, synced
4. 💬 button on the player → chat; **Join voice** for voice (allow the mic
   prompt for netflix.com). Use headphones to avoid echo.

## How it works

- `extension/background.js` – holds the WebSocket per tab (outside Netflix's CSP)
- `extension/content.js` – party logic, clock sync, playback sync, chat, voice, overlay
- `extension/page.js` – runs in Netflix's page to drive its internal player API
  (setting `video.currentTime` directly triggers Netflix error M7375)
- `server/core.js` – rooms, state relay, chat, WebRTC signaling (shared)
- `server/server.js` – Node transport; `server/worker/` – Cloudflare transport

Protocol frames: `{ type, reqId?, data }`; replies echo `reqId`.
Shared state: `{ playing, position (ms), at (server ms), videoId }`.
Expected position = `position + (playing ? serverNow − at : 0)`.

## Known limits

- Episode changes reload followers' tabs; voice reconnects automatically after.
- Voice is a mesh: great up to ~6 people in voice, heavier beyond that.
- Netflix's internal player API is undocumented and can change.

## Credits

Teleparty's extension was studied for inspiration using
[REA (rea-agents)](https://www.npmjs.com/package/rea-agents), a reverse-engineering CLI and MCP server.
No Teleparty or REA code is included; NetParty is an original implementation.
