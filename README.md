# NetParty — watch Netflix and JioHotstar together

A Chrome extension + tiny sync server. Everyone in the party needs the extension and
their own account on the service (Netflix or JioHotstar).

Supported: **Netflix** (`netflix.com/watch/...`) and **JioHotstar**
(`hotstar.com/in/.../watch`, movies, shows and episodes).

Features
- Playback sync: play, pause, seek, and episode changes follow the party
  (server-clock sync, 1 s seek threshold, drift correction every 3 s)
- Invite links: `https://netparty.tech/j/<code>` opens an invite page that sends
  friends to the right title (auto-joins) and lets them download the extension while the party is live
- Split-screen chat: the player shrinks to make room for a docked chat column (nothing covers the
  player controls); hide it to go back to full width
- Chat with message bubbles, Send button and Enter to send, unread badge and message previews
  (works in fullscreen; keys typed in chat never reach the site's hotkeys)
- Voice chat: peer-to-peer WebRTC audio, mute, volume, speaking indicator
- Host-only control lock, host hand-off when the host leaves, auto-reconnect

## Quick start (2 minutes)

1. **Download** this repo: green **Code** button → **Download ZIP**, then unzip it
   (or `git clone https://github.com/velvetthunder15/netparty.git`).
2. **Install** in Chrome: open `chrome://extensions`, turn on **Developer mode**,
   click **Load unpacked**, and pick the `extension` folder.
3. **Pin** NetParty from the puzzle-piece menu.
4. **Host**: open any title on Netflix or JioHotstar, press play, click NetParty → **Start a party**.
   The invite link is copied to your clipboard.
5. **Invite**: send the link. It opens an invite page: friends without NetParty get a
   download + 3-step install there, then press **Join on Netflix/JioHotstar** and land on the same title, in sync.
6. **Talk**: the chat panel opens on the right; the round purple button reopens it.
   Type and press Enter (or the send arrow). **Join voice chat** and allow the mic to talk.

No server setup needed: the extension uses the hosted server by default.

## Using NetParty

| Action | How |
| --- | --- |
| Start a party | **Start a NetParty** button next to Play / More Info (Netflix) or under Watch (JioHotstar): opens the title and starts the party. Or, on a playing title, NetParty icon → **Start a party** |
| Join a party | Open the invite link, or icon → paste the link or code → **Join** |
| Copy invite again | **Copy invite** in the chat panel, or icon → **Copy invite link** |
| Chat | Purple chat button on the right of the player; Enter or the arrow sends; Esc closes |
| Voice | **Join voice chat** in the panel; mic button mutes, red button leaves, slider sets friends' volume |
| Lock controls | Host: icon → **Only I can play, pause and skip** |
| Change your name | Icon → **Your name** (before starting or joining) |
| Leave | Exit the title, or **Leave party**. If the host leaves, the party ends for everyone; a guest leaving just leaves. Next episode keeps the party going. |

Tips
- Everyone needs their own account on a plan that streams that title in their region.
- JioHotstar: ads on ad-supported plans play separately for each person; after an ad, press play/pause once to resync.
- Use headphones on voice to avoid echo.
- If someone drifts, pressing play/pause once resyncs everyone.
- On strict college or mobile networks voice may not connect; see TURN below.

## Troubleshooting

- **Nothing happens**: reload the Netflix or JioHotstar tab after installing or updating the extension.
- **"Party not found"**: the host's party ended or the code is wrong; ask for a fresh link.
- **No mic prompt / no audio**: click the lock icon in the address bar → allow Microphone for the site, then rejoin voice.
- **Netflix error after a seek**: reload the tab; the party rejoins automatically.

## 1. The server

A hosted server is live at `wss://netparty.tech` (also reachable at wss://netparty.chiragrasane15.workers.dev); landing page at https://netparty.tech, privacy at /privacy, download at /download/netparty-extension.zip
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
3. Click the NetParty icon → **Advanced** to change the server URL
   (defaults to the hosted server; use `ws://localhost:8787` for a local one)

## 3. Use it

1. Open any title on netflix.com and press play
2. NetParty icon → **Start a party** (invite link is copied)
3. Friends open the link → invite page → **Join**; they land on the same title, synced
4. Chat panel on the right; **Join voice chat** for voice (allow the mic
   prompt for the site). Use headphones to avoid echo.

## How it works

- `extension/background.js` – holds the WebSocket per tab (outside Netflix's CSP)
- `extension/early.js` – runs at page start: keeps the invite code if the site rewrites the URL, and
  routes keys typed in the panel away from the site's hotkeys
- `extension/content.js` – party logic, clock sync, playback sync, chat, voice, overlay (shadow DOM)
- `extension/page.js` – runs in the site's page: drives Netflix's internal player API
  (setting `video.currentTime` directly triggers Netflix error M7375) and the plain
  HTML5 `<video>` on JioHotstar
- `server/core.js` – rooms, state relay, chat, WebRTC signaling (shared)
- `server/server.js` – Node transport; `server/worker/` – Cloudflare transport
- `GET /j/<code>` – invite page; `/j/<code>/netparty.zip` – extension download, only while that party is live
  (Worker bundles it: run `npm run deploy` in `server/`; Node: set `EXTENSION_ZIP=/path/to.zip`)
- `e2e/` – real-Chromium test: two browsers, fake Netflix/JioHotstar pages, invite → join → chat → sync

Protocol frames: `{ type, reqId?, data }`; replies echo `reqId`.
Shared state: `{ playing, position (ms), at (server ms), videoId }`.
Expected position = `position + (playing ? serverNow − at : 0)`.

## Known limits

- Episode changes reload followers' tabs; voice reconnects automatically after.
- Voice is a mesh: great up to ~6 people in voice, heavier beyond that.
- Netflix's internal player API is undocumented and can change.
- JioHotstar support is untested on a live account so far; live sports/TV streams are not synced (no shared timeline).
- Everyone in a party watches on the same service; a Netflix party can't include JioHotstar viewers.

## Credits

Teleparty's extension was studied for inspiration using
[REA (rea-agents)](https://www.npmjs.com/package/rea-agents), a reverse-engineering CLI and MCP server.
No Teleparty or REA code is included; NetParty is an original implementation.

## v1.3.1
- Split-screen no longer crops the video: only the site's player box is narrowed (Netflix `.sizing-wrapper` / `.watch-video--player-view`, JioHotstar the outermost full-width player container) and the player re-lays out the picture itself.
- Reloading the page (or changing episode) keeps your seat: chat history is replayed (last 150 lines), the host stays host, voice reconnects, the chat panel stays open or closed as you left it, and friends don't see "left/joined" spam. A dropped connection keeps its seat for 15 seconds.
- The chat panel only shows on watch pages, so Netflix's browse pages aren't covered.

## v1.4.0

- **Start a NetParty** button on Netflix (home billboard, next to More Info, and the title details pop-up) and JioHotstar (title page, under Watch). One click opens the title and creates the party with the chat open.
- Leaving the title ends the party: the host exiting (back to browse, another page) closes it for everyone and friends see "<host> ended the party"; a guest exiting just leaves. Nobody gets pulled back into the movie anymore. Going to the next episode stays on a watch page, so the party continues and friends follow.
- Joining from a browse page sends you to the party's title first.
- Parties are saved on the server, so a server restart no longer causes "Party not found"; tabs reconnect and rejoin on their own and keep retrying (no more giving up after a few tries).
