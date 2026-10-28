# NetParty — watch Netflix, JioHotstar, YouTube and Prime Video together

A Chrome extension (also Edge, Brave; Firefox build in `scripts/`) + tiny sync server. Everyone in the party
needs the extension and, for Netflix, JioHotstar and Prime Video, their own account on the service.

Supported:
- **Netflix** (`netflix.com/watch/...`)
- **JioHotstar** (`hotstar.com/in/.../watch`, movies, shows and episodes)
- **YouTube** (`youtube.com/watch?v=...` videos; Shorts, live streams and m.youtube.com aren't supported)
- **Prime Video** (new in 1.8, not yet tested on a live account): a title's page on `primevideo.com`
  (`/detail/<id>`, also under `/region/…` and `/-/<lang>/`) or on an Amazon store's Prime Video pages,
  `amazon.<tld>/gp/video/detail/<ASIN>` (`.com`, `.co.uk`, `.de`, `.co.jp`, `.in`, `.ca`, `.com.au`, `.fr`, `.it`,
  `.es`, `.com.br`, `.com.mx`, `.nl`; the extension also runs on `/Amazon-Video/` pages). Start from the title's page;
  Amazon product pages (`amazon.<tld>/<name>/dp/<ASIN>`) aren't supported.

Features
- **End-to-end encrypted chat**: messages, GIFs, reactions, names and pictures (and voice-call setup)
  are encrypted in the browser with a key that lives only in the invite link; the server can't read them
  (see [End-to-end encryption](#end-to-end-encryption))
- Playback sync: play, pause, seek, and episode changes follow the party
  (server-clock sync, 1 s seek threshold, drift correction every 3 s)
- Invite links: `https://netparty.tech/j/<code>#k=<key>` opens an invite page that sends
  friends to the right title (auto-joins) and lets them download the extension while the party is live
- Split-screen chat: the player shrinks to make room for a docked chat column (nothing covers the
  player controls); hide it to go back to full width
- Chat with message bubbles, Send button and Enter to send, unread badge and message previews
  (works in fullscreen; keys typed in chat never reach the site's hotkeys)
- Profile pictures: pick a cute emoji (🐶 🐼 🦊 🍕 🍩 🍿 …) in the popup or by clicking your picture in the
  chat panel; it shows next to your messages and in the people list, and updates live for everyone
- Emoji picker in the chat bar (smileys, gestures, animals, food, activities, symbols, recently used)
- 🎉 Reactions: tap one of 5 emojis and it floats up over everyone's video (also in fullscreen).
  Defaults 😂 😭 💀 🥰 😱; change them in the tray (pencil) or the popup's Chat settings
- GIFs from KLIPY, with the picker pre-filled with what you're watching, plus quick chips
  (reaction, lol, omg, popcorn). Needs the server's KLIPY key, see "GIFs" below
- Links in chat are clickable (open in a new tab)
- Chat text size: Small / Medium / Large (Aa in the chat bar, or the popup's Chat settings)
- Voice chat: peer-to-peer WebRTC audio, mute, volume, speaking indicator
- Video chat (1.8): turn your camera on next to voice; everyone with a camera on shows as a 16:9 tile, docked in
  the chat panel by default (1.9) or popped out into a floating window you can drag, resize and fold.
  640x360 at up to 24 fps, at most 4 cameras at once, peer to peer (see the TURN note below)
- Change your name or picture from the panel: click your picture (or your camera tile's name) → Your profile
- Light and dark themes for the chat panel and popup: follows your system, or pick one in Settings → Theme
- Every chat line shows the sender's picture and name, your own included
- Host-only control lock, host hand-off when the host leaves, auto-reconnect

## Quick start (2 minutes)

1. **Download** this repo: green **Code** button → **Download ZIP**, then unzip it
   (or `git clone https://github.com/velvetthunder15/netparty.git`).
2. **Install** in Chrome: open `chrome://extensions`, turn on **Developer mode**,
   click **Load unpacked**, and pick the `extension` folder.
3. **Pin** NetParty from the puzzle-piece menu.
4. **Host**: open any title on Netflix, JioHotstar or Prime Video (or a YouTube video), press play, click NetParty → **Start a party**
   (or the **Start a NetParty** button on the page).
   The invite link is copied to your clipboard.
5. **Invite**: send the link. It opens an invite page: friends without NetParty get a
   download + 3-step install there, then press **Join on Netflix/JioHotstar/YouTube/Prime Video** and land on the same title, in sync.
6. **Talk**: the chat panel opens on the right; the round purple button reopens it.
   Type and press Enter (or the send arrow). **Join voice chat** and allow the mic to talk; the camera
   button in the voice bar turns on video.

No server setup needed: the extension uses the hosted server by default.

## Using NetParty

| Action | How |
| --- | --- |
| Start a party | **Start a NetParty** button next to Play / More Info (Netflix), under Watch (JioHotstar), next to Play on a Prime Video title page, or next to Like under a YouTube video: starts the party. Or, on a playing title, NetParty icon → **Start a party** |
| Join a party | Open the invite link, or icon → paste the **full** invite link → **Join** (the code alone can't unlock the encrypted chat) |
| Copy invite again | **Copy invite** in the chat panel, or icon → **Copy invite link** |
| Chat | Purple chat button on the right of the player; Enter or the arrow sends; Esc closes |
| Voice | **Join voice chat** in the panel; mic button mutes, red button leaves, slider sets friends' volume |
| Video | In voice, the camera button turns your camera on/off. Tiles sit in the chat panel; the pop-out button floats them over the video (drag by the bar, resize from the corner, arrow folds it away, dock button puts them back). With the chat closed they float until you reopen it |
| Your name / picture | Click your picture in the panel (or the name on your camera tile) → **Your profile**: type a name and press Enter, or pick a picture. Or icon → name field |
| Theme | Icon → **Settings** → **Theme**: System (default, follows your computer), Light or Dark |
| Emoji / GIF / react | Chat bar: 🙂 opens emoji, **GIF** opens the GIF search, 🎉 opens the reaction tray (pencil = change them) |
| Text size | **Aa** in the chat bar cycles Small / Medium / Large; or icon → **Settings** |
| Lock controls | Host: icon → **Only I can play, pause and skip** |
| Change your name or picture | Icon → **You** (the picture opens the picker), or click your own picture in the chat panel |
| Leave | Exit the title, or **Leave party**. If the host leaves, the party ends for everyone; a guest leaving just leaves. Next episode keeps the party going. |

Tips
- Everyone needs their own account on a plan that streams that title in their region.
- JioHotstar: ads on ad-supported plans play separately for each person; after an ad, press play/pause once to resync.
- Prime Video: the party is tied to the title's page with the player open; closing the player leaves the party
  (the host closing it ends it). While Prime shows you an ad, sync pauses for you and you catch up afterwards.
  Episodes that play inside the same player without changing the address aren't followed automatically:
  everyone picks the next episode.
- YouTube: ads play separately for each person. While yours plays, the panel shows "Waiting for ad to finish"
  and nothing is synced; when it ends you jump to where the party is. Switching video moves the whole party.
- Use headphones on voice to avoid echo.
- If someone drifts, pressing play/pause once resyncs everyone.
- On strict college or mobile networks voice may not connect; see TURN below.

## Troubleshooting

- **Nothing happens**: reload the Netflix or JioHotstar tab after installing or updating the extension.
- **"Party not found"**: the host's party ended or the code is wrong; ask for a fresh link.
- **"Paste the full invite link"**: the link was cut off before `#k=…` (or only the code was shared). Ask for the whole link.
- **"Can't decrypt messages — check your invite link"**: the key in the link doesn't belong to that party (a mangled or mixed-up link). Ask for the full link again.
- **"Update NetParty …"**: you (or a friend) still run 1.6 or older; 1.7 parties are encrypted and need 1.7 on everyone's browser.
- **No mic prompt / no audio**: click the lock icon in the address bar → allow Microphone for the site, then rejoin voice.
- **"Camera blocked"**: same place → allow Camera for the site, then press the camera button again.
  "Your camera is in use by another app" means another app (Zoom, Meet…) has it.
- **A friend's camera tile stays on their picture**, or "Voice/video link … failed": your networks can't connect
  peer to peer (no relay server yet, see TURN below).
- **Netflix error after a seek**: reload the tab; the party rejoins automatically.
- **"GIFs aren't available right now"**: the server has no KLIPY key yet (see GIFs below).

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

### GIFs (KLIPY)

GIF search goes through the server so the API key never ships in the extension
(`GET /api/gifs/search?q=&pos=` and `GET /api/gifs/trending`, cached ~10 min, rate limited per IP,
`contentfilter=medium`). Tenor's API shut down on 2026-06-30, so NetParty uses
[KLIPY](https://klipy.com)'s Tenor-compatible API.

1. Get a free API key at https://partner.klipy.com
2. Add it as a Worker secret: Cloudflare dashboard → **Workers & Pages** → **netparty** → **Settings** →
   **Variables and Secrets** → **Add** → type **Secret**, name `KLIPY_KEY`, paste the key → **Deploy**
   (or `cd server/worker && npx wrangler secret put KLIPY_KEY`).
   Node server: start it with `KLIPY_KEY=... npm start`.

Without a key the endpoints answer `503 {"error":"gifs_unavailable"}` and the extension shows
"GIFs aren't available right now". GIFs in chat are only accepted from KLIPY's media hosts
(`static.klipy.com`, `static1.klipy.com`, `static2.klipy.com`). If a site's CSP blocks those
images in the page, the extension fetches them in its background worker and shows them from a
`blob:` URL.

For friends on other networks the server must be public over `wss://`. Any Node
host works (Render, Railway, Fly.io, a VPS behind Caddy/Nginx). Set `PORT` if
your host requires it. Health check: `GET /health`.

Voice and video use Google STUN and connect peer to peer. On strict networks (symmetric NAT) (some college/mobile networks) peers
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

## End-to-end encryption

Since 1.7 everything people *say* in a party is end-to-end encrypted. The sync server (and Cloudflare,
and anyone who could read its storage or logs) only ever handles ciphertext.

How it works
- **The key.** The host's browser makes a random 256-bit AES-GCM key (WebCrypto) when the party starts.
  It travels only in the invite link's fragment, `https://netparty.tech/j/<code>#k=<key>` (browsers never
  send the part after `#` to a server). The invite page reads it with its own script (which may not fetch
  anything: `connect-src 'none'`, script pinned by hash), checks it against the party's encrypted key
  check, and passes it on in the watch link's fragment (`…?npParty=<code>#npKey=<key>`). The extension
  takes it out of the address bar at `document_start`, before the streaming site's scripts run, and keeps it
  in `chrome.storage.session` for that tab (memory only, not synced, not readable by the site; deleted when
  the party ends, you leave, or the tab closes). Reloads, episode/video changes and reconnects keep it.
- **What is encrypted.** Chat text, GIF messages (the KLIPY URL), reactions, display names and pictures (one
  encrypted "profile" per member), and WebRTC voice setup (SDP and ICE candidates, which contain IP addresses).
  Each message gets a fresh 96-bit IV; the additional data binds it to the party code, the kind of message and
  the sender's public member id, so it can't be replayed into another party or passed off as someone else's.
  Plaintext is padded to 64-byte steps so sizes leak less. Format: `base64url(0x01 | IV | ciphertext+tag)`.
- **Checks move to the receiver.** The server can't see content, so each browser checks what it decrypts:
  GIFs must be `https` on KLIPY's media hosts, reactions and pictures must be a single emoji, names at most 24
  characters with no control characters, text at most 500. Anything else (or anything that fails to decrypt) is
  dropped. The server still checks shape and size of every ciphertext and rate-limits chat, reactions and profiles.
- **Join/leave lines** ("Rahul joined") are stored as "member *pid* joined" and named by each browser.
- **Seats.** Each tab has a private 128-bit reconnect id (`cid`) that only the server sees; everyone else sees
  a random public member id (`pid`). Knowing someone's pid can't take their seat or the host role.
- **Joining needs the full link.** A bare code, or a link without a valid key, is refused with
  "Paste the full invite link — the code alone can't unlock the encrypted chat." A wrong key is caught before
  joining: "Can't decrypt messages — check your invite link".
- **Versions.** 1.7 parties are flagged encrypted; 1.6 and older clients get "Update NetParty …" instead of a
  broken chat, and 1.7 refuses plaintext parties ("ask the host to update").

What the server can still see: the party code; members' random ids and how many there are; when messages,
reactions and voice-setup messages are sent and roughly how big they are; playback state (playing/paused,
position, timestamps) and the video id of what's playing (the invite page needs it to send friends to the right
title), plus who is in voice and muted/speaking; IP addresses and connection times (and Cloudflare's own request
logs); GIF search terms, which have to go to KLIPY through our `/api/gifs` proxy (not logged; nothing about the
party or names is sent with them).

Limits: anyone with the full link can join and read the chat, so share it like a key. The panel is drawn inside
the streaming site's page, so that site's own scripts could in principle read what's on screen. The link
(with its key) can end up in your browser history, like any link you open. The server is still trusted to relay
messages honestly (it can't read or forge them, but it could drop or delay them).

## How it works

- `extension/background.js` – holds the WebSocket per tab (outside Netflix's CSP)
- `extension/early.js` – runs at page start: keeps the invite code if the site rewrites the URL, and
  routes keys typed in the panel away from the site's hotkeys
- `extension/content.js` – party logic, clock sync, playback sync, chat (emoji, GIFs, links), reactions, voice and video
  (WebRTC mesh: the caller offers a video slot up front, so the camera is added with `replaceTrack`, no renegotiation),
  overlay (shadow DOM, light/dark), Prime Video's overlay player
- `extension/emoji-data.js` – bundled emoji lists (pictures, picker, default reactions); shared by content script, popup, background
- `extension/page.js` – runs in the site's page: drives Netflix's internal player API
  (setting `video.currentTime` directly triggers Netflix error M7375) and the plain
  HTML5 `<video>` on JioHotstar (YouTube and Prime Video's `<video>` are driven straight from content.js)
- `server/core.js` – rooms, seats (private cid → public pid), state relay, encrypted chat/profile/reaction
  relay with size checks and rate limits, encrypted WebRTC signaling relay, invite page (shared)
- `server/gifs.js` – KLIPY GIF search proxy (shared by Node and the Worker)
- `server/server.js` – Node transport; `server/worker/` – Cloudflare transport
- `GET /j/<code>` – invite page (reads the key from `#k=` in the browser only); `/j/<code>/netparty.zip` – extension download, only while that party is live
  (Worker bundles it: run `npm run deploy` in `server/`; Node: set `EXTENSION_ZIP=/path/to.zip`)
- `e2e/` – real-Chromium tests: two browsers, fake Netflix/JioHotstar/YouTube pages, a mock KLIPY;
  `run.mjs` (invite → join → chat → sync), `lifecycle.mjs`, `features.mjs` (avatars, emoji, reactions,
  text size, links, GIFs; `CSP=strict` for a strict image CSP), `youtube.mjs` (start, sync, ads, video change, dock),
  `prime.mjs` (mock Prime Video / Amazon pages: start, invite, sync both ways, ads, dock, title change, leaving),
  `v18.mjs` (own avatar, light/dark + contrast audit, video chat with fake cameras: docked view, pop out, drag,
  resize, dock back, fullscreen, reload, panel closed; profile name editing; camera denied, HiDPI);
  `e2e/firefox/` runs the Firefox build (incl. Firefox ↔ Chromium voice and video)

Protocol frames: `{ type, reqId?, data }`; replies echo `reqId`.
Shared state: `{ playing, position (ms), at (server ms), videoId }`.
Expected position = `position + (playing ? serverNow − at : 0)`.

## Known limits

- Emoji are drawn by each computer's own emoji font: Apple's emoji on Macs and iPhones, Segoe on
  Windows, Noto on Android/Linux (no emoji images are bundled).
- YouTube's real page can change its layout; the split-screen dock narrows `ytd-watch-flexy` and the top bar.
- Episode changes reload followers' tabs; voice reconnects automatically after.
- Voice is a mesh: great up to ~6 people in voice, heavier beyond that. Video is limited to 4 cameras, and each
  camera is uploaded once per viewer (lower quality as more people watch).
- No TURN relay server yet: voice and video only work when the browsers can reach each other directly.
- Prime Video support is built from Prime's public player markup and tested on a mock page only; Prime can change
  it, and `video.currentTime` may not match the time Prime shows (everyone gets the same offset, so sync holds).
- Netflix's internal player API is undocumented and can change.
- JioHotstar support is untested on a live account so far; live sports/TV streams are not synced (no shared timeline).
- Everyone in a party watches on the same service; a Netflix party can't include JioHotstar viewers. On Prime Video,
  guests open the title on the host's store (primevideo.com or that amazon.<tld>).

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

## v1.6.0

- **YouTube**: watch pages (`youtube.com/watch?v=…`) with a **Start a NetParty** button next to Like,
  play/pause/seek sync, switching video moves the party, ads pause sync for that viewer ("Waiting for ad
  to finish") and they catch up afterwards, split-screen dock in default, theater and fullscreen. Invite
  pages and the popup name the right platform.
- **Profile pictures**: emoji avatars on a soft circle (random one to start), in the popup and the panel,
  shown in the people list and next to chat messages, updated live.
- **Emoji picker** in the chat bar (inserts at the cursor, recently used row, Esc closes).
- **🎉 Reactions** float over everyone's video (hover 🎉 for the tray; each click sends one, rate limited to 12 per 3 s), customisable.
- **GIFs** via KLIPY (server-side key; add `KLIPY_KEY`), suggested from the current title, "Powered by KLIPY".
- **Links** in chat are clickable; **chat text size** Small / Medium / Large.
- Protocol additions are optional fields and new message types (`avatar`, `react`, chat `gif`), so 1.5
  clients keep working in the same party (they see "GIF" for a GIF and no reactions).

## v1.7.0

- **End-to-end encrypted chat** (see [End-to-end encryption](#end-to-end-encryption)): messages, GIFs, reactions,
  names, pictures and voice setup are encrypted with a per-party key that lives only in the invite link and the
  participants' browsers. Invite links now look like `https://netparty.tech/j/<code>#k=<key>`; **share the full
  link** (a bare code no longer works). 1.6 clients are asked to update.
- **Security fix:** chat history no longer exposes anyone's reconnect id. Members are identified by a random
  public id; the private 128-bit per-tab id only ever goes to the server, so nobody can reclaim someone else's
  seat or the host role.
- The server stores only ciphertext, and an idle saved party is deleted within 6 hours (checked every 15 min).
- The invite page names who invited you by decrypting it in your browser, and refuses links without a valid key.

## v1.9.0

- **Cameras docked in the chat panel** by default: big 16:9 tiles (up to ~62% of the panel), chat keeps 4+ lines,
  compact panel chrome while they show. **Pop out** into a floating, resizable window (drag anywhere, fold, dock back;
  keyboard too; works in fullscreen); the choice, place and size are kept per tab. Chat closed → cameras float.
- **Your profile** in the panel now edits your name as well as your picture.

## v1.8.0

- **Prime Video** (primevideo.com and amazon.<tld>/gp/video): start button, sync, ads, dock, invites. Untested on a live account.
- **Video chat**: optional camera tiles on the voice mesh (640x360, ≤24 fps, max 4 cameras), draggable and collapsible.
- **Light mode** (System / Light / Dark in Settings), WCAG AA contrast in both themes.
- Your own messages show your picture and name. Crisp icons on HiDPI (SVG logo, 32 px toolbar icon).
- Security: only known title-id shapes become links (invite page, follow-the-host). Full list in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE). Netflix, JioHotstar, YouTube and Prime Video are trademarks of their owners; NetParty is not affiliated with them.
