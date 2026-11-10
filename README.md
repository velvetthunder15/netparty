# NetParty: watch Netflix, Prime Video, YouTube, JioHotstar, HBO Max, Crunchyroll, SonyLIV and other video sites together

NetParty is a free, open-source browser extension and a small sync server for watch parties. Start a party on a video,
send one link, and everyone's play, pause and seek stay in sync, with end-to-end encrypted chat, voice and video chat
beside the video. Everyone needs the extension and, for the streaming services, their own account on the service.
Website: https://netparty.tech

## Install

| Browser | Where |
| --- | --- |
| Firefox | [Firefox Add-ons (AMO)](https://addons.mozilla.org/en-US/firefox/addon/netparty/) |
| Microsoft Edge | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/netparty/cbbgchcialmecjommdohdfmolliinjki) |
| Chrome, Brave and other Chromium browsers | the zip from [netparty.tech](https://netparty.tech/#install) (or this repo's `extension/` folder): `chrome://extensions` → **Developer mode** → **Load unpacked** |
| Opera | coming soon |

The Firefox package is built from the same source by `node scripts/build-firefox.mjs`.

## Supported sites

- **Netflix** (`netflix.com/watch/...`)
- **JioHotstar** (`hotstar.com/in/.../watch`, movies, shows and episodes)
- **YouTube** (`youtube.com/watch?v=...` videos; Shorts, live streams and m.youtube.com aren't supported)
- **Prime Video**: a title's page on `primevideo.com`
  (`/detail/<id>`, also under `/region/…` and `/-/<lang>/`) or on an Amazon store's Prime Video pages,
  `amazon.<tld>/gp/video/detail/<ASIN>` (`.com`, `.co.uk`, `.de`, `.co.jp`, `.in`, `.ca`, `.com.au`, `.fr`, `.it`,
  `.es`, `.com.br`, `.com.mx`, `.nl`; the extension also runs on `/Amazon-Video/` pages). Start from the title's page;
  Amazon product pages (`amazon.<tld>/<name>/dp/<ASIN>`) aren't supported.
- **HBO Max** (2.2): `play.hbomax.com/video/watch/<id>[/<id>]` (`play.max.com` redirects there)
- **Crunchyroll** (2.2): `crunchyroll.com/watch/<id>/<slug>`, also under a language prefix (`/fr/watch/…`). The video
  plays in Crunchyroll's player frame (`static.crunchyroll.com/vilos-v2/…`); NetParty's frame agent drives it there
- **SonyLIV** (2.2): the player (`?watch=true`) on `sonyliv.com/shows/<show>-<id>/<episode>-<id>`, `/movies/<slug>-<id>`
  and the other title paths (`/sports/…`, `/clip/…`, `/trailer/…`, `/music-videos/…`)
- **Videos on sites you choose** (2.0): on any other http(s) page, the popup's **Sync this tab** starts a
  party for the page's video. NetParty runs there only after that click (`activeTab` + `scripting`), or on sites
  you set to **Always allow on this site** (an optional host permission for that one site). See
  [Sync any video](#sync-any-video).

## Features

Watching together
- Playback sync: play, pause, seek and episode changes follow the party
  (server-clock sync, 1 s seek threshold, drift correction every 3 s)
- Waits for loading videos (2.2): when someone's video stalls for over a second, everyone pauses ("Waiting for
  Rahul to load…") and plays on together from the same moment once it has loaded, or after 20 seconds anyway
- Pauses on drop-outs (2.2): a member whose connection drops mid-video pauses the party until they're back (within
  the server's 15-second grace), then it plays on by itself; if they don't come back, anyone in control gets Resume
- Next episode keeps the party together; host-only control lock, host hand-off when the host leaves, auto-reconnect
- Invite links: `https://netparty.tech/j/<code>#k=<key>` opens an invite page that sends friends to the right title
  (auto-joins) and lets them get the extension while the party is live
- Split-screen chat: the player shrinks to make room for a docked chat column (nothing covers the player controls)

Chat
- **End-to-end encrypted**: messages, GIFs, reactions, names, pictures and voice-call setup are encrypted in the
  browser with a key that lives only in the invite link; the server can't read them
  (see [End-to-end encryption](#end-to-end-encryption))
- Message bubbles, unread badge and previews, works in fullscreen; keys typed in chat never reach the site's hotkeys
- Replies and reactions on messages (2.1), emoji picker with search (2.1), 🎉 reactions floating over the video,
  GIFs from KLIPY, clickable links, text size Small / Medium / Large
- Typing indicator, @mentions, spoilers (`||hidden words||` or the **Spoiler** switch), edit and delete your own
  messages, and one pinned message per party (2.2)
- Light and dark themes for the chat panel and popup

Voice and video
- Voice chat: WebRTC audio between friends, mute, volume, speaking indicator
- Video chat (1.8): up to 4 cameras as 16:9 tiles, docked in the chat panel or popped out into a floating window
  (640x360 at up to 24 fps)
- Works on any network: peer to peer when the two networks allow it, otherwise through a Cloudflare TURN relay
  (UDP, TCP and TLS on 443). Relay credentials are refreshed for long parties and reconnects (2.2)
- Lower the video while friends talk (2.2): the video plays at 30% of its volume while someone else speaks

Profile
- Your name, and a picture: one of 48 **HD pictures** (2.2, Microsoft Fluent Emoji 3D, bundled with the extension),
  an emoji, or **your own photo** (2.2): cropped and shrunk to 96 x 96 in your browser, kept in this browser only and
  shared only with your party, end-to-end encrypted. Pick it in the popup or by clicking your picture in the panel
- Settings in the panel (⚙ in the chat bar) and the popup switch off the waiting, the drop-out pause and the
  lowering of the video (all on by default)

## Quick start (2 minutes)

1. **Get it**: Firefox and Edge from their add-on stores (see [Install](#install)). Chrome: download the zip from
   [netparty.tech](https://netparty.tech/#install) and unzip it (or clone this repo).
2. **Install** in Chrome: open `chrome://extensions`, turn on **Developer mode**,
   click **Load unpacked**, and pick the unzipped folder (the repo's `extension` folder).
3. **Pin** NetParty from the puzzle-piece menu.
4. **Host**: open any title on Netflix, JioHotstar, Prime Video, HBO Max, Crunchyroll or SonyLIV (or a YouTube video), press play, click NetParty → **Start a party**
   (or the **Start a NetParty** button on the page).
   The invite link is copied to your clipboard.
5. **Invite**: send the link. It opens an invite page: friends without NetParty get a
   download + 3-step install there, then press **Join on Netflix** (or JioHotstar, YouTube, Prime Video, HBO Max, Crunchyroll, SonyLIV) and land on the same title, in sync.
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
| Your name / picture | Click your picture in the panel (or the name on your camera tile) → **Your profile**: type a name and press Enter, pick an HD picture or an emoji, or **Upload photo** (**Remove photo** takes it away). Or icon → **You** |
| Theme | Icon → **Settings** → **Theme**: System (default, follows your computer), Light or Dark |
| Emoji / GIF / react | Chat bar: 🙂 opens emoji (type in its search box to find one), **GIF** opens the GIF search, 🎉 opens the reaction tray (pencil = change them) |
| Reply / react to a message | Hover a chat line (tap it on touch) → **Reply** or **React**; Esc or × cancels a reply; tap a reaction chip to add or remove yours |
| Edit / delete / pin | Hover your own line → **Edit** (Enter saves, Esc cancels) or **Delete** (press twice). **Pin** (host, or anyone while everyone controls playback) puts it in the bar above the chat |
| Mention / spoiler | Type **@** and pick a name (arrows + Enter or Tab). Put `||double bars||` around a spoiler, or press the crossed-out eye in the chat bar to hide the whole message |
| Party settings | ⚙ in the chat bar, or icon → **Settings** → **Party and voice**: waiting for loading videos, pausing on drop-outs, lowering the video while friends talk |
| Text size | **Aa** in the chat bar cycles Small / Medium / Large; or icon → **Settings** |
| Sync another site | Open the video, icon → **Sync this tab**. Friends: invite link → **Open the video** → icon on that page → **Join party on this tab** |
| Theater (other sites) | **Theater** in the panel: the video fills the window next to the chat (the player's own fullscreen hides the chat) |
| Lock controls | Host: icon → **Only I can play, pause and skip** |
| Leave | Exit the title, or **Leave party**. If the host leaves, the party ends for everyone; a guest leaving just leaves. Next episode keeps the party going. |

Tips
- Everyone needs their own account on a plan that streams that title in their region.
- JioHotstar: ads on ad-supported plans play separately for each person; after an ad, press play/pause once to resync.
- Prime Video: the party is tied to the title's page with the player open; closing the player leaves the party
  (the host closing it ends it). While Prime shows you an ad, sync pauses for you and you catch up afterwards.
  Episodes that play inside the same player without changing the address aren't followed automatically:
  everyone picks the next episode.
- HBO Max, Crunchyroll, SonyLIV (2.2): start the party from the NetParty icon on a playing episode (no "Start a
  NetParty" button on their pages yet). Ads play separately for each person; sync pauses for you while yours shows.
- YouTube: ads play separately for each person. While yours plays, the panel shows "Waiting for ad to finish"
  and nothing is synced; when it ends you jump to where the party is. Switching video moves the whole party.
- Use headphones on voice to avoid echo.
- If someone drifts, pressing play/pause once resyncs everyone.
- On strict college or mobile networks voice goes through the relay (TURN) server; see TURN below.

## Troubleshooting

- **Nothing happens**: reload the Netflix or JioHotstar tab after installing or updating the extension.
- **"Party not found"**: the host's party ended or the code is wrong; ask for a fresh link.
- **"Paste the full invite link"**: the link was cut off before `#k=…` (or only the code was shared). Ask for the whole link.
- **"Can't decrypt messages — check your invite link"**: the key in the link doesn't belong to that party (a mangled or mixed-up link). Ask for the full link again.
- **"Update NetParty …"**: you (or a friend) still run 1.6 or older; 1.7 parties are encrypted and need 1.7 on everyone's browser.
- **No mic prompt / no audio**: click the lock icon in the address bar → allow Microphone for the site, then rejoin voice.
- **"Camera blocked"**: same place → allow Camera for the site, then press the camera button again.
  "Your camera is in use by another app" means another app (Zoom, Meet…) has it.
- **A friend's camera tile stays on their picture**, or "Couldn't connect voice/video": the link failed even
  through the relay. Both of you leave voice and join again; check the server's `GET /health` shows `"relay":"ok"`.
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

Voice and video use Google STUN and connect peer to peer. On strict networks (symmetric NAT, many college and
mobile networks) they go through a TURN relay. netparty.tech uses Cloudflare Realtime TURN: create a TURN key in
the Cloudflare dashboard (Realtime, TURN Server) and set the Worker secrets `TURN_KEY_ID` and
`TURN_KEY_API_TOKEN` (`wrangler secret put`). The server mints 24-hour credentials per voice join and caches them.
`GET /health` shows `"relay":"ok"` once it works. A fixed TURN server also works with env vars:
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
  encrypted "profile" per member: `{ name, avatar, hd?, img? }`, where 2.2 adds the HD picture's id and an uploaded
  photo), WebRTC voice setup (SDP and ICE candidates, which contain IP addresses), and
  (2.0) the page address and video length of an any-video party, and (2.2) mentions, spoilers, edits, deletes, the
  pinned message (kept with the party as ciphertext) and the typing / "my video is loading" signals (relayed, never stored).
  Each message gets a fresh 96-bit IV; the additional data binds it to the party code, the kind of message and
  the sender's public member id, so it can't be replayed into another party or passed off as someone else's.
  Plaintext is padded to 64-byte steps so sizes leak less. Format: `base64url(0x01 | IV | ciphertext+tag)`.
- **Checks move to the receiver.** The server can't see content, so each browser checks what it decrypts:
  GIFs must be `https` on KLIPY's media hosts, reactions and emoji pictures must be a single emoji, an HD picture
  must be one of the bundled ids (`av:<slug>`), a photo must be a `data:` WebP, JPEG or PNG of at most 12,400
  characters that decodes as an image (never a URL; it's shown from a `blob:` or `data:` URL or drawn on a
  `<canvas>`, whichever the site's CSP allows), names at most 24 characters with no control characters, text at
  most 500. Anything else (or anything that fails to decrypt) is
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
position, speed, timestamps) and the video id of what's playing (the invite page needs it to send friends to the right
title; for a video on another site it's a random `av:` id), plus who is in voice and muted/speaking, and whose connection dropped (2.2); when typing / "my video is loading" signals are sent (2.2, encrypted and never stored); IP addresses and connection times (and Cloudflare's own request
logs); GIF search terms, which have to go to KLIPY through our `/api/gifs` proxy (not logged; nothing about the
party or names is sent with them).

Usage totals (server only, since 2026-11-10): the hosted server counts anonymous daily totals per India-time
day: distinct people (HMAC-SHA256 of IP address + user agent with a random salt made fresh each day; the salt and
that day's hashes are deleted when the day ends, only the count is kept), parties started, joins, the most people
online at once, the biggest party, and parties per service (from the unencrypted video id prefix the server
already gets). Totals are kept 120 days. No IPs, user agents, names, chat, room codes, title ids or URLs are stored,
no cookies, no third parties, nothing new sent by the extension. Code: `server/stats.js`; the owner reads them at
`/stats` (secret `STATS_TOKEN`; anything else gets a 404). The self-hosted Node server (`server.js`) counts nothing.

Limits: anyone with the full link can join and read the chat, so share it like a key. The panel is drawn inside
the streaming site's page, so that site's own scripts could in principle read what's on screen. The link
(with its key) can end up in your browser history, like any link you open. The server is still trusted to relay
messages honestly (it can't read or forge them, but it could drop or delay them).

## Sync any video

2.0 adds parties for videos on sites that aren't one of the supported services.

- **Starting**: the popup shows **Sync this tab** on any http(s) page that isn't a supported service. The click injects
  `any-mode.js`, `early.js`, `emoji-data.js`, `anyvideo.js` and `content.js` into that tab only
  (`chrome.scripting.executeScript` under `activeTab`, so there is no new install-time host warning). Existing site
  adapters are unchanged; `any-mode.js` switches `content.js` to the generic adapter.
- **Finding the video** (`anyvideo.js`): `<video>` elements in the page, in open shadow roots and in same-origin
  iframes. The playing one wins, else the clearly largest visible one (2.5x the next); otherwise a highlight overlay
  asks the user to click one. play / pause / seeked / ratechange / timeupdate / durationchange are hooked, and when
  the site replaces the element (an ad, the next episode) the new element where the old one was is picked up.
- **Cross-origin players**: a video inside a cross-origin iframe needs that frame's site: the popup asks with
  `chrome.permissions.request` (optional host permission, one origin) and injects `anyvideo.js` into the tab's frames
  (`allFrames`); it then runs as an agent that the tab's main script drives through the background
  (`npAgent` / `npFrame` messages, by tab and frame id). Refused: the popup says the video can't be synced.
  Canvas-only players: "No video found on this page".
- **Sync**: same protocol as the other sites. The party's `videoId` is `av:<16 random chars>` (never a link), and the
  state may carry `rate` (playback speed). Small drift (over 250 ms) is closed by playing up to 10% faster or slower;
  over 2.5 s the guest seeks. Live streams (infinite duration) sync play and pause only.
- **The page address** is end-to-end encrypted: `{ u: address, d: duration in s, -1 = live }` sealed with the room key
  (AAD `room|page|`), sent by the host with a `page` message whenever it changes. The server stores and relays the
  ciphertext only. The invite page decrypts it in the guest's browser, accepts only `http:`/`https:` addresses with no
  credentials that round-trip through `URL` unchanged, and sets it as the `href` of **Open the video** (never into HTML).
- **Joining**: on that page the guest's popup offers **Join party on this tab**: it finds the full invite link in an
  open invite tab (`…/j/<code>#k=<key>`, via the `tabs` permission) or a party key this tab already holds. Pasting
  the invite link works too.
- **Different video**: if both durations are known and differ by more than 3 s, the guest sees "You're on a different
  video" with **Open host's page**, and sync pauses for them.
- **Always allow on this site** registers the scripts for that origin (`chrome.scripting.registerContentScripts`),
  so a reload rejoins. Unticking it (or removing the site's access in the browser) unregisters them.
- **Theater mode**: inline `!important` styles make the video (or the iframe holding it) fill the window left of the
  chat; the page's own styles are put back exactly afterwards. Optional document full screen keeps the chat.

## How it works

- `extension/background.js` – holds the WebSocket per tab (outside Netflix's CSP)
- `extension/any-mode.js`, `extension/anyvideo.js` – "Sync any video" (2.0): the flag for chosen pages and the
  generic video adapter (finding, picker overlay, Theater, cross-origin frame agent)
- `extension/early.js` – runs at page start: keeps the invite code if the site rewrites the URL, and
  routes keys typed in the panel away from the site's hotkeys
- `extension/content.js` – party logic, clock sync, playback sync, chat (emoji, GIFs, links), reactions, voice and video
  (WebRTC mesh: the caller offers a video slot up front, so the camera is added with `replaceTrack`, no renegotiation),
  overlay (shadow DOM, light/dark), Prime Video's overlay player, HBO Max / SonyLIV / Crunchyroll adapters (2.2), typing,
  mentions, spoilers, edit / delete, pins, buffer-aware sync, pause on drop and auto-duck (2.2)
- `extension/emoji-data.js` – bundled emoji lists (pictures, picker, default reactions) and the list of HD pictures; shared by content script, popup, background
- `extension/avatars/` – the 48 HD pictures (`av-<slug>.webp`, 128 px, Microsoft Fluent Emoji 3D, MIT; see `LICENSES.md` there).
  The background worker reads them for the content script, so they aren't web-accessible resources
- `extension/page.js` – runs in the site's page: drives Netflix's internal player API
  (setting `video.currentTime` directly triggers Netflix error M7375) and the plain
  HTML5 `<video>` on JioHotstar (YouTube, Prime Video, HBO Max and SonyLIV's `<video>` are driven straight from
  content.js; Crunchyroll's, inside its player frame, through `anyvideo.js` running there as an agent)
- `server/core.js` – rooms, seats (private cid → public pid), state relay, encrypted chat/profile/reaction
  relay with size checks and rate limits, encrypted WebRTC signaling relay, invite page (shared)
- `server/gifs.js` – KLIPY GIF search proxy (shared by Node and the Worker)
- `server/server.js` – Node transport; `server/worker/` – Cloudflare transport
- `GET /j/<code>` – invite page (reads the key from `#k=` in the browser only); `/j/<code>/netparty.zip` – extension download, only while that party is live
  (Worker bundles it: run `npm run deploy` in `server/`; Node: set `EXTENSION_ZIP=/path/to.zip`)
- `e2e/` – browser tests, see [Development and testing](#development-and-testing)

Protocol frames: `{ type, reqId?, data }`; replies echo `reqId`.
Shared state: `{ playing, position (ms), at (server ms), videoId }`.
Expected position = `position + (playing ? serverNow − at : 0)`.

## Development and testing

```bash
cd server && npm install && npm test          # protocol, encryption, persistence and leak tests (Node server)
TARGET=wss://netparty.tech node server/test.js  # the same against a deployed server (EXPECT_TURN=1 also checks the relay)
node scripts/build-firefox.mjs                 # Firefox (AMO) package from extension/
```

`e2e/` drives real Chromium (Playwright) with the unpacked extension against `fakesite.mjs` (fake Netflix, JioHotstar,
YouTube, Prime Video, HBO Max, Crunchyroll and SonyLIV pages and a mock KLIPY) and a local server, through a
recording proxy that checks no WebSocket frame carries names, messages, keys or pictures in the clear. Run one with
`SCRIPT=<suite>.mjs ./go.sh` (`CSP=strict` adds a strict image CSP to the fake Netflix). See `e2e/README.md`.

| Suite | What it covers |
| --- | --- |
| `run.mjs` | invite → join → chat → sync → reloads keep seats and history |
| `lifecycle.mjs` | leaving, host ending the party, episode changes |
| `features.mjs` | pictures, emoji, reactions, text size, links, GIFs, popup, voice signaling, reload, invite-link errors (also `CSP=strict`) |
| `youtube.mjs`, `prime.mjs` | YouTube and Prime Video: start, sync, ads, dock, title changes |
| `anyvideo.mjs` | Sync any video (2.0): popup flows, encrypted page address, speed, drift, iframes, Theater |
| `v18.mjs` | video chat: docked and floating cameras, layouts, themes and contrast, HiDPI, camera denied |
| `scroll.mjs` | chat scroll position |
| `chat2.mjs` | 2.1 replies, message reactions, emoji search, with a 2.0.2 build from git (also `CSP=strict`) |
| `chat3.mjs` | 2.2 typing, mentions, spoilers, edit / delete, pins, buffer-aware sync, pause on drop, auto-duck, with 2.1.0 and 2.0.2 builds (also `CSP=strict`) |
| `platforms.mjs` | 2.2 HBO Max, Crunchyroll and SonyLIV on test pages |
| `avatars.mjs` | 2.2 HD pictures, photo upload / remove, the 2.1.0 emoji fallback, `blob:` / `data:` / `<canvas>` fallbacks, hostile profiles, leak audit (also `CSP=strict`) |
| `relaycreds.mjs` | 2.2 relay credentials: calls use the newest ones, a reconnect after a dropped socket uses the new ones |
| `firefox/` | the Firefox build: `ffrun.mjs`, `ffcross.mjs` (Firefox ↔ Chromium chat, sync, voice, video), `ffavatars.mjs` |

## Known limits

- Emoji are drawn by each computer's own emoji font: Apple's emoji on Macs and iPhones, Segoe on
  Windows, Noto on Android/Linux. The 48 HD pictures are bundled images.
- NetParty 2.1 and older show a member's HD picture or photo as the closest emoji.
- YouTube's real page can change its layout; the split-screen dock narrows `ytd-watch-flexy` and the top bar.
- Episode changes reload followers' tabs; voice reconnects automatically after.
- Voice is a mesh: great up to ~6 people in voice, heavier beyond that. Video is limited to 4 cameras, and each
  camera is uploaded once per viewer (lower quality as more people watch).
- Voice and video use a Cloudflare TURN relay when a direct link fails; very locked-down networks that block UDP and TCP to turn.cloudflare.com can still stop calls.
- Prime Video support is built from Prime's public player markup and tested on a mock page only; Prime can change
  it, and `video.currentTime` may not match the time Prime shows (everyone gets the same offset, so sync holds).
- Netflix's internal player API is undocumented and can change.
- JioHotstar support is untested on a live account so far; live sports/TV streams are not synced (no shared timeline).
- HBO Max, Crunchyroll and SonyLIV support (2.2) is built from their public URL formats and page structure and tested
  on test pages that copy it, not on the real services (we can't sign in to them). Their ad markers and title
  selectors are the least certain parts; SonyLIV's title page counts as the player once a large video shows.
- Older NetParty versions in the same party (2.1, 2.0) see mentions as plain "@Name" and spoilers as "[spoiler]",
  keep showing edited and deleted messages as they were first sent, and don't show typing, waiting or pins.
- Everyone in a party watches on the same service; a Netflix party can't include JioHotstar viewers. On Prime Video,
  guests open the title on the host's store (primevideo.com or that amazon.<tld>).

## Credits

- HD profile pictures: [Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji) (3D style),
  Copyright (c) Microsoft Corporation, MIT License; trimmed and resized to 128 px WebP. Licence and file list in
  `extension/avatars/LICENSES.md` and `extension/avatars/LICENSE-FluentEmoji-MIT.txt`. Not an endorsement by Microsoft.
- Inter font (SIL Open Font License) in the panel and popup.
- GIF search by [KLIPY](https://klipy.com).
- Teleparty's extension was studied for inspiration using
  [REA (rea-agents)](https://www.npmjs.com/package/rea-agents), a reverse-engineering CLI and MCP server.
  No Teleparty or REA code is included; NetParty is an original implementation.

## Version history

Every release is in [CHANGELOG.md](CHANGELOG.md). 2.2.0 added HBO Max, Crunchyroll and SonyLIV, buffer-aware sync,
pause on drop-outs, typing, @mentions, spoilers, edit / delete, pinned messages, lowering the video while friends talk,
HD profile pictures and your own photo, and fresher relay credentials for voice and video.

## License

MIT, see [LICENSE](LICENSE). Netflix, JioHotstar, YouTube, Prime Video, HBO Max, Crunchyroll and SonyLIV are trademarks of their owners; NetParty is not affiliated with them.
