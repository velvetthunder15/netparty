# Changelog

All notable changes to NetParty (the browser extension and its sync server) are in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are commit dates (IST).

## [2.5.0] - 2026-11-12
### Added
- **Live streams on YouTube, Twitch, Kick and Rumble.** A live party syncs how far behind the live edge everyone
  watches (there's no shared timeline in a live stream). Viewers ahead of the one furthest behind wait for them (a jump
  back where the player still has that part of the stream, else a pause of up to a minute, shown in the panel), play
  and pause follow the party, a rewind on YouTube moves everyone, and **Go live** in the panel takes everyone to now.
  The panel shows "● Live · 0:12 behind live". See [Live streams](README.md#live-streams).
- YouTube live streams at their own addresses: `/live/<id>` and `/@channel/live` (the watch page says which video).
- **Twitch** (`twitch.tv/<channel>`), **Kick** (`kick.com/<channel>`) and **Rumble** (`rumble.com/<id>-<slug>.html`,
  live or not), with ads (no sync while one plays), titles, another stream moving the party, and **Start a NetParty**
  on the player.
- Website: a separate **Live streams** row (YouTube Live, Twitch, Kick, Rumble) and an FAQ entry.

### Changed
- New video ids `yl:`, `tw:`, `kk:`, `rl:` (live) and `rb:`, and a `golive` playback reason (server). Invite pages for
  them ask for 2.5 and, like YouTube's and Tubi's, no account.
- A party started on a YouTube or Rumble video before the page showed it was live moves to the live id; starting a
  party there waits up to 9 s for the page to tell.
- Members of a live party send their delay every 3 s as an end-to-end encrypted signal (older versions ignore it).
- A party update from NetParty 2.4 or older for a live party's video only counts for play and pause.
- After waiting for a loading or dropped member, a live party plays on from the delay it grew to while paused.

### Fixed
- Tubi's invite page no longer asks for "your own Tubi account" (it's free).

## [2.4.0] - 2026-11-12
### Added
- **Hulu, Disney+, Paramount+, STARZ and Tubi**: parties on `www.hulu.com/watch/<id>`, `www.disneyplus.com/play/<id>`
  (also `/video/<id>` and under a language prefix such as `/en-gb/`), `www.paramountplus.com/shows/video/<id>/` and
  `/movies/video/<id>/`, `www.starz.com/<country>/<language>/play/<id>`, and Tubi's title pages
  (`tubitv.com/movies/<id>/<slug>`, `/tv-shows/<id>/<slug>`) once the player is up. Invite links, the next episode,
  ads (Hulu, Disney+, Paramount+ and Tubi: no sync while one plays) and the docked chat work as on the other
  services. Disney+ keeps its `<video>` inside its player's shadow root; NetParty looks there too. Built from the
  services' public page structure and checked against test pages only, like the 2.2 services.
- **Start a NetParty on the player**: every service's watch page (not just the title pages on Netflix, JioHotstar,
  Prime Video and YouTube) gets a small **Start a NetParty** button at the top right of the player. It shows while
  you move the mouse, like the player's own controls, and **×** hides it for that title.
- **Update reminders**: when a newer NetParty is out, the toolbar icon shows **↑**, the popup shows **NetParty x.y.z
  is out** with a one-line What's new and **Update now**, and the supported sites show a small reminder (once a day,
  or one chat line during a party). **Update now** asks the store for the update and restarts into it (Edge,
  Firefox), or opens the download page (the zip build, where **Reload NetParty** in the popup picks up the new
  files). The server's new `GET /api/version` says which version it hands out (read from `extension/manifest.json`
  and `extension/whats-new.json` at deploy).
- **What's new**: after an update, the popup (once) and the next supported page (a short notice) list up to three
  lines from `extension/whats-new.json`; the icon shows **NEW** until the popup has shown it.

### Changed
- The popup's **or open** list is Netflix, JioHotstar, Prime Video and YouTube, with the services' icons from
  netparty.tech.
- Parties start faster: the socket opens while the player loads (and when the popup opens on a title, or the pointer
  is on **Start a NetParty**), and the clock sync sends its samples together (one round trip instead of five; the
  fastest answer wins).
- A play or pause made while a party update was being applied is no longer swallowed and then undone by the drift
  check: it's looked at again once the update is done.
- Server: `hu:`, `dp:`, `pp:`, `sz:` and `tb:` video ids (strict shapes; anything else is dropped), invite pages for
  the new services (they ask for 2.4), and their counts in the daily totals.

### Fixed
- **Start a NetParty** next to Play could fail with "Could not reach the party server": a replaced socket's late
  `close` (from a reconnect, a tab coming back into view, or two starts at once) was taken for the new socket's, which
  set off a loop of reconnects that each closed the socket before. Every socket's events are now tagged and old ones
  ignored, an `open` that's already under way is never sent again, a hanging handshake is given up after 12 seconds,
  and a start that fails no longer leaves the tab reconnecting in the background. Starting from the popup and from
  the page at once makes one party, not two. When the extension was updated under an open page, the page now says to
  reload it.
- **Start a NetParty** sometimes didn't show: an old button the site had hidden (single-page sites keep old pages
  around) blocked a new one on JioHotstar, Prime Video and YouTube, buttons below the fold were skipped, and
  YouTube's newer layouts had no row it knew. Hidden buttons are replaced, a lower Play button is used when there's
  none on screen, and YouTube falls back to the actions row.

## [2.3.0] - 2026-11-11
### Added
- **Host controls**: click a friend's picture in the chat panel. The host can **Make host** (hands the party over;
  the role moves with that person's tab, so it stays with them when they reload and the old host comes back as a
  guest) and **Remove from party** (press twice). A removed person's tab can't rejoin; the chat says "Priya was
  removed from the party" and their panel says the host removed them.
- **Lock the party**: the host's **Lock the party** switch (⚙ in the chat bar → **Party**, or in the popup) stops new
  people from joining. People already in the party can still reload and reconnect. The invite page says "This party
  is locked" and doesn't auto-join, and the panel header shows "· locked".
- **Hand over before leaving**: the host's **Leave party** opens a menu: **Make Rahul host and leave** for each
  connected friend, or **End the party for everyone**. With nobody else connected it asks to end the party, as
  before.
- **Per-person voice volume**: in voice chat, a friend's menu has a volume slider (0 to 100%) that changes only how
  loud they are for you. It multiplies the friends' volume slider in the voice bar, and is kept for that tab and
  party, so it survives a reload.
- **Party recap**: when you leave a party (or press **Recap** in the panel), NetParty offers a 1080 x 1350 image of
  it: the title and service, how long you watched together, who was there, and four numbers picked from messages,
  reactions (with the most used one), the biggest moment, who chatted most, time in voice and the most people at
  once. **Download** saves a PNG, **Copy image**
  puts it on the clipboard. It's offered after at least a minute of watching or three messages and reactions, and
  not when the host removed you.
- **One share block**: **Invite** in the panel and the popup's party view now have **Copy link**, **WhatsApp**,
  **Discord**, **Instagram** and **QR code**. The app buttons copy the invite link and open the app's own web page
  (WhatsApp Web, Discord's direct messages, Instagram's inbox) for you to paste it into a chat. **QR code** shows the
  link as a QR code to scan with a phone: in the popup, or from the panel in a small NetParty window (`qr.html`),
  which closes when the party ends.

### Changed
- Server: new `lock`, `remove` and `promote` messages (host only). The `settings` broadcast and the party
  snapshot carry `locked`, `peek` returns it, and a new `removed` message tells the removed member. The server
  keeps the lock and the private reconnect ids of removed members (up to 200) with the party, so they survive a
  restart, and deletes them with the party. A server older than 2.3 answers the new messages with "Unknown type.",
  which the extension shows as "Your party server doesn't support this yet".
- The share buttons never put the invite link in an app's address (such as `wa.me/?text=…`): that would hand the
  key after the `#` to the app's servers. The QR code is drawn by the extension (`extension/qr.js`), not by a QR
  service, and never inside the streaming site's page (the panel is part of that page, and the site could read a
  canvas there): the panel hands the link to the background, which shows it in NetParty's own window.
- 2.3 clients tell the server they have the host controls (`hc: 1` in `create` and `join`). A lock stays on only
  while the host has them: if the host role passes to someone on NetParty 2.2 or older (a hand-over, or the role
  falling to them when the host leaves), the party unlocks, because they couldn't unlock it.
- **Make host** from a stand-in (someone who took over when the host left without ending the party) passes the
  role on, but the party's own host still gets it back on returning, as from any stand-in. Only the party's own
  host hands it over for good.
- Removing someone doesn't change the party's key: they still have the invite link, and could join again from a new
  tab while the party is unlocked. Lock the party to keep them out.
- The recap is made on your device only. Its running totals stay in this tab's session storage (deleted when the
  party ends or the tab closes) and photos only in memory; nothing about it is sent anywhere unless you share the
  image yourself.
- With friends on NetParty 2.2 or older: the server still refuses new joins to a locked party and removed tabs,
  and a friend made host gets the host controls they already know. Their chat doesn't show the "was removed" or "is
  the host now" lines (the removed person just drops off the list). A removed person on 2.2 isn't told: their panel
  stays open, but they no longer get the party and the server refuses what they send.

### Fixed
- After a reconnect that the server refuses (the party ended, or you were removed while your connection was down),
  voice chat now stops too: the microphone and camera were left on with the panel gone.

## [2.2.0] - 2026-11-06
### Added
- **HBO Max, Crunchyroll and SonyLIV**: start and join parties on `play.hbomax.com` (and `play.max.com`, which now
  redirects there) at `/video/watch/<id>`, on Crunchyroll's `/watch/<id>/…` pages (also under a language prefix such
  as `/fr/`; the video plays in Crunchyroll's player frame from `static.crunchyroll.com`, which NetParty drives from
  inside that frame) and on SonyLIV's player (`/shows/…`, `/movies/…` and the other title paths with `?watch=true`).
  Play, pause, seek and episode changes sync; sync stops while an ad shows and catches up after it. Start a party
  from the popup there (no "Start a NetParty" buttons on those sites yet). Built from the services' public page
  structure and tested against test pages that copy it: we can't sign in to these services, so they're untested on
  the real sites.
- **Waits when someone's video is loading**: if a friend's video stalls for more than a second, the party pauses for
  everyone ("Waiting for Rahul to load…") and plays on together, from the same moment, once it has loaded. After 20
  seconds it plays on anyway and says so in the chat. Only the member whose video is stuck says so; the host decides
  for the party. Anyone pressing play, pause or seek decides instead.
- **Pauses when someone drops out**: when a member's connection drops while the video plays (not when they press
  Leave), the party pauses ("Priya disconnected, paused") and plays on by itself when they're back within 15 seconds.
  If they don't come back, anyone who can control playback gets a **Resume** button.
- **Typing indicator**: "Rahul is typing…" or "2 people are typing…" above the chat box.
- **@mentions**: type @ to pick someone from the party (names with spaces work). Mentions show the person's current
  name; a line that mentions you is highlighted, and the message preview and unread badge say so while the chat is
  closed.
- **Spoilers**: put `||double bars||` around words, or switch on **Spoiler** in the chat bar to hide the whole message.
  Spoilers stay blurred until each person taps them. A reply to a spoiler only quotes "Spoiler".
- **Edit and delete your messages** from the message's action bar (Delete asks for a second press). Edited messages
  say "(edited)"; deleted ones leave "Message deleted".
- **Pin a message**: the host (or anyone, while everyone controls playback) can pin one message. It shows in a bar
  above the chat; click it to jump to the message, × to unpin. People who join later see it too.
- **Lower the video while friends talk**: in voice chat the video plays at 30% of its volume while someone else is
  speaking, and goes back to exactly your volume 600 ms after they stop (or when you leave voice). A change you make
  while it's lowered is kept.
- **Settings** in the chat panel (the ⚙ in the chat bar) and in the popup: switch off waiting for loading videos,
  pausing on drop-outs, or lowering the video while friends talk (all on by default).
- **HD profile pictures**: 48 new pictures (animals, characters and food from Microsoft's Fluent Emoji 3D set, MIT
  licence) come with the extension and show first in the picture picker, in the chat panel and the popup. Emoji
  pictures stay in an **Emoji** section. New installs start with a random HD picture.
- **Your own photo**: **Upload photo** in the chat panel's "Your profile" crops a picture to a square, shrinks it to
  96 x 96 and keeps it in this browser only (`chrome.storage.local`, never synced). It goes to the party inside
  your end-to-end encrypted profile, so only people in your party see it. **Remove photo** takes it away; picking
  an HD picture or an emoji replaces it.

### Changed
- Everything new stays end-to-end encrypted. Typing and "my video is loading" are short encrypted signals the server
  passes on and never stores (a new `ev` message, rate-limited to 24 per 10 seconds); the pinned message is stored
  with the party as ciphertext only (a new `pin` message). The server now tells the party when a member's connection
  drops (an `away` flag), and accepts the new playback reasons `buffer`, `drop` and `resume`.
- Mentions, spoilers, edits and deletes ride inside the encrypted chat line. NetParty 2.1 and 2.0 show mentions as
  plain "@Name", show "[spoiler]" in place of hidden text, ignore edits and deletes (they keep showing the original
  message), and ignore typing, waiting and pins.
- A player event that only repeats what the party is already doing is no longer sent to the party (a seek NetParty
  made for the party could finish late on a slow connection and look like your own seek).
- Profiles now carry `{ name, avatar, hd?, img? }`: `avatar` stays an emoji (the HD picture's closest emoji), so
  NetParty 2.1 and older show 🦊 where 2.2 shows the HD fox, and an emoji instead of a photo. Pictures are never
  loaded from a URL: HD pictures come from the extension's own files, photos are checked (`data:` WebP, JPEG or
  PNG only, at most 9 KB, must decode as an image) and shown from a `blob:` URL, a `data:` URL or a `<canvas>`,
  whichever the site's Content-Security-Policy allows. The server's profile size limit grew to fit a photo
  (still rate-limited to 10 profile updates per 10 seconds per connection).

### Fixed
- **Voice and video over the relay after a long party**: relay (TURN) credentials are now re-fetched before a call
  when they're over 6 hours old, and always when a link is being reconnected after it failed, on both sides (the
  answering side refreshes when the same friend calls again). After the party connection drops and comes back, voice
  chat now uses the new credentials from the server instead of the ones from when you first joined.

## [2.1.0] - 2026-11-06
### Added
- **Replies**: hover a chat line (tap or long-press on touch) and press **Reply**. A strip above the chat box
  says who you're replying to (× or Esc cancels). The sent message carries a small quote of the original (name and
  one line, or "GIF"); clicking it scrolls to the original and highlights it while it's still in the chat.
- **Message reactions**: **React** on a chat line offers 👍 ❤️ 😂 😮 😢 🔥, and **+** opens the full emoji picker.
  Reactions show as chips under the message with a count, highlighted when one is yours; tap a chip to add or
  remove yours, hover it to see who reacted. They're kept in the party's history, so people who join or reload see
  them. (The floating 🎉 reactions over the video are unchanged.)
- **Emoji search**: a search box at the top of the emoji picker finds emoji by name or keyword across all
  categories (names from Unicode CLDR, bundled with the extension). Enter picks the first result, Esc clears the
  search and then closes the picker.

### Changed
- Chat lines now carry a random message id inside the encryption so replies and reactions can point at them.
  Replies and reactions are ordinary end-to-end encrypted chat lines: the server sees and stores only ciphertext,
  and they count against the same size cap, rate limit and 150-line history as any message. Clients on 2.0.x show
  replies as plain messages and ignore reactions; lines sent by 2.0.x can still be replied to and reacted to.

## [2.0.2] - 2026-11-06
### Fixed
- **Voice and video chat now connect on any network**: calls go through a relay (TURN) server when the two
  networks block a direct peer-to-peer link (mobile data, hostel and college Wi-Fi, carrier NAT). The server
  hands out short-lived relay credentials; a dropped link reconnects on its own with fresh ones (twice).
- **Chat opens at the newest message**: after closing and reopening the chat, or reloading with it closed, it
  showed the first message. It now returns to the newest line, or to where you had scrolled up to.

## [2.0.1] - 2026-11-03
### Fixed
- **Sync this tab on a paused video**: when no video was playing and the page had more than one (often a second
  player layer stacked behind the real one), NetParty asked you to pick instead of starting. It now prefers the
  video you've been watching, then one with media loaded, and resolves stacked players on its own.

## [2.0.0] - 2026-11-03
### Added
- **Sync any video**: on a site that isn't Netflix, JioHotstar, YouTube or Prime Video, the popup offers
  **Sync this tab**. NetParty runs on that tab only after the click (Chrome's `activeTab` and `scripting`
  permissions, which add no install-time warning), finds the video and starts a party. It finds videos in the page,
  in open shadow roots and in same-origin iframes. It picks the playing video, or the clearly largest one; when
  several look alike it highlights them and you click the one you mean. When the site swaps the video element
  (an ad, the next episode) NetParty follows the new one.
- **Invite page for any-video parties**: the page's address travels end-to-end encrypted with the party key, so our
  server never sees it. The invite page decrypts it in your friend's browser, accepts only plain http(s)
  addresses, and shows **Open the video**. On that page, friends click the NetParty icon and press
  **Join party on this tab** (the popup finds the invite they opened).
- **Always allow on this site** (optional): asks the browser for that one site and registers NetParty there, so
  reloads keep the party. Untick it in the popup to remove it again.
- **Players inside another site's frame**: if the video is in a cross-origin iframe, the popup asks for access to
  that player's site only. If you say no, it tells you the video can't be synced.
- **Different video check**: if a guest's video length differs from the host's by more than 3 seconds, the panel says
  "You're on a different video" with an **Open host's page** button, and sync pauses for that guest.
- **Live streams** (infinite duration) sync play and pause only.
- **Smoother sync** on any-video pages: small gaps are closed by playing up to 10% faster or slower for a moment,
  big gaps by a seek. Playback speed is synced too.
- **Theater mode** in any-video parties: the video fills the window next to the chat, with an optional full screen
  that keeps the chat visible (the player's own fullscreen button hides the chat, which the button's tooltip says).
### Changed
- Server: `av:<16 chars>` video ids, an encrypted `page` message (host only, size-capped, stored with the party),
  an optional `rate` in the playback state, and the invite page's "Open the video" variant. Other parties work as
  before.
- `web_accessible_resources`: the panel stylesheet and font can load on any http(s) page (needed for any-video tabs).

## [1.9.2] - 2026-10-29
### Changed
- **New font**: the chat panel and the popup now use Inter, bundled with the extension (SIL Open Font License,
  `extension/fonts/OFL.txt`), so NetParty looks the same on Windows, macOS, Linux and in Firefox instead of
  following each system's font. It is loaded under its own name, so the site's fonts are never touched, and the
  system font is still used for anything Inter doesn't cover (and until it loads).

## [1.9.1] - 2026-10-28
### Changed
- **Resize the popped-out cameras from any edge or corner**, not only the small grip in the corner. The
  cursor shows the direction, the opposite edge stays where it was, and tiles stay 16:9. The size is still
  remembered for the tab, and the corner grip still works with the arrow keys.
- **Messages sent close together stack**: when the same person sends more lines within a minute of their
  first one, those lines sit under it without repeating the name and picture, so quick bursts don't fill the
  chat. Anyone else's message, or a gap of a minute or more, starts a new group with the name and picture.

## [1.9.0] - 2026-10-28
### Added
- **Cameras docked in the chat**: when anyone's camera is on, the tiles now sit inside the chat panel by default
  as a 16:9 grid sized to the panel: one camera is one big tile across the panel, more cameras take whichever
  arrangement gives the biggest tiles (in the narrow docked column that is a single column). The camera view takes
  up to about 62% of the panel's height, always leaving room for at least four lines of chat and the composer.
  While cameras are docked the panel's other chrome gets compact: a one-line header with Copy invite and
  Leave party as icon buttons, the Watching row as small avatars without names, and a tighter voice bar. The
  normal layout comes back when no camera is on.
- **Pop out**: a button on the camera view detaches it into a floating window over the page (440 px wide by
  default, two tiles per row). Drag it anywhere by its bar (also over the chat), resize it from its corner (tiles
  stay 16:9), fold it away, and dock it back into the chat with its dock button. The move and resize handles also
  work with the arrow keys (Shift for bigger steps). It works in fullscreen. Docked or popped out, position, size
  and folded state are remembered for the tab.
- With the chat closed, docked cameras show in that floating window so you keep seeing your friends; its dock
  button opens the chat with the cameras docked again. Fold the window to keep just a small bar.
- **Change your name from the panel**: clicking your picture in the Watching row (or the name on your own camera
  tile) opens **Your profile**, which now has a name field next to the pictures. Enter or leaving the field saves
  it (same 24-character limit as the popup; empty is ignored; Esc cancels) and everyone in the party sees it.
- Camera tiles show who is speaking (green ring) and who is muted.

### Changed
- The camera strip is replaced by the docked view and the pop-out window (the old strip was 160x90 tiles).
- Your picture button is now labelled "Change your name and picture".
- New controls use soft-touch styling: no tap highlight and a gentle press; motion is off with prefers-reduced-motion.
- Tests: `e2e/v18.mjs` now also covers the docked default (1, 2 and 3 cameras at 1280x720 to 1920x1080, both
  themes, no overflow, chat keeps four lines), the chat closed, pop out, drag, resize (mouse and keyboard), dock
  back, fullscreen, the choice surviving a reload, clicks on tiles never reaching the player, and the profile name
  field reaching the other peer.

## [1.8.1] - 2026-10-28
### Changed
- The camera strip can now be dragged over the chat panel as well as the video, so it never has to cover the movie.

## [1.8.0] - 2026-10-28

### Added
- **Prime Video**: `primevideo.com` (including `/region/…` and `/-/<lang>/` paths) and the Amazon stores'
  `amazon.<tld>/gp/video` and `/Amazon-Video` pages (`.com`, `.co.uk`, `.de`, `.co.jp`, `.in`, `.ca`, `.com.au`,
  `.fr`, `.it`, `.es`, `.com.br`, `.com.mx`, `.nl`). Play, pause, seek and buffering follow the party through the
  overlay player's HTML5 `<video>`; a **Start a NetParty** button sits next to Play on a title's page; invites open
  the title with `?autoplay=1`; Prime's ad countdown pauses sync for that viewer, who catches up afterwards; the
  docked chat narrows the overlay player; closing the player leaves the party (the host closing it ends it).
  Built from Prime's public player markup and tested against a mock page; not yet tested on a live Prime account.
- **Video chat** (optional camera next to voice): camera on/off in the voice bar, small tiles for everyone with
  the camera on (yours mirrored), draggable and collapsible, kept clear of the docked chat. Uses the voice
  WebRTC mesh and its end-to-end encrypted signalling; capped at 640x360 and 24 fps, at most 4 cameras at once,
  and each copy gets a lower bitrate and size as more people watch. Clear messages when the camera is blocked,
  missing or busy. Peer to peer only (no TURN relay yet), so it can fail on strict networks.
- **Light mode** for the in-page panel, pickers, toasts and the popup. Follows the system's light/dark setting by
  default; **Settings → Theme** (System / Light / Dark) overrides it and is saved. Text meets WCAG AA contrast in
  both themes.
- Your own chat messages show your picture and name, like everyone else's (on the right), and follow changes.
- Tests: `e2e/prime.mjs` (29 checks), `e2e/v18.mjs` (56 checks: own avatar, themes + contrast audit, video
  chat between two Chromium browsers with fake cameras, permission denied, HiDPI), camera checks in the
  Firefox ↔ Chromium suite, and server tests for Prime invite links and video id validation.

### Changed
- The popup's "Chat settings" is now "Settings". Its header logo is the SVG mark; the toolbar icon gains a 32 px
  size, so nothing is drawn from an upscaled small PNG on HiDPI screens (profile pictures are emoji glyphs).
- Filled buttons and your chat bubbles use a slightly deeper purple (#6C4CF5) so white text passes AA; the chat
  button uses the brand gradient (#7C5CFF → #B05CFF).
- The invite page names the browsers NetParty installs in (Chrome or Brave, Edge from the Edge Add-ons store;
  Firefox and Opera coming soon) and asks for 1.8 on Prime Video parties.

### Security
- The server only accepts title ids in the known Netflix / JioHotstar / YouTube / Prime Video shapes, and the
  extension only follows those: a party member can no longer turn the invite page or the party's "follow the
  host" navigation into a link to another site (e.g. a crafted `hs:` id).

## [1.7.1] - 2026-10-27

### Changed
- The 🎉 reaction tray opens on hover (a click pins it; touch and keyboard still use click), and each click sends
  exactly one emoji. Reaction limit raised from 6 to 12 per 3 seconds.

## [1.7.0] - 2026-10-27

### Added
- **End-to-end encrypted chat**: messages, GIFs, reactions, names, pictures and voice-call setup are encrypted
  with AES-256-GCM in the browser. The key lives only in the invite link's `#fragment`
  (`https://netparty.tech/j/<code>#k=<key>`) and the participants' browsers; the server relays and stores
  ciphertext only. Joining needs the full link.
- Idle saved parties are deleted within 6 hours.

### Security
- Members are identified by a random public id; the private 128-bit reconnect id never leaves the server, so
  nobody can take someone else's seat or the host role.

### Changed
- 1.6 and older clients are asked to update; 1.7 refuses plaintext parties.

## [1.6.0] - 2026-10-27

### Added
- **YouTube** watch pages: start button next to Like, sync, switching video moves the party, ads pause sync for
  that viewer, docked chat in default, theater and fullscreen.
- Emoji profile pictures, emoji picker, 🎉 floating reactions, GIFs via KLIPY (server-side key), clickable links,
  chat text size (Small / Medium / Large).

## [1.5.0] - 2026-10-26

### Added
- `netparty.tech` domain: the Worker serves the landing page, `/privacy` and the `/download` zip.

## [1.4.2] - 2026-10-26

### Changed
- New NetParty icon (violet chat bubbles with a play triangle).

## [1.4.1] - 2026-10-26

### Fixed
- Start buttons find the real Play / Watch buttons on Netflix and JioHotstar.

## [1.4.0] - 2026-10-26

### Added
- **Start a NetParty** buttons next to Play on Netflix and under Watch on JioHotstar.
- Parties survive server restarts (saved in Durable Object storage).

### Changed
- Leaving the title ends the party for everyone if you're the host, or just takes you out if you're a guest.

## [1.3.1] - 2026-10-26

### Fixed
- Split screen no longer crops the video (only the site's player box is narrowed).
- Reloading or changing episode keeps your seat, the host role, chat history and the panel state.

## [1.3.0] - 2026-10-26

### Added
- Split-screen docked chat: the player shrinks to make room for the chat column.

### Changed
- Lighter DOM work on the streaming pages.

## [1.2.0] - 2026-10-25

### Added
- Invite pages (`/j/<code>`) with a download that only works while the party is live.
- Redesigned panel and popup; browser end-to-end tests.

### Fixed
- Enter and Send in chat (keys no longer reach the site's hotkeys).

## [1.1.0] - 2026-10-25

### Added
- JioHotstar support.

## [1.0.0] - 2026-10-25

### Added
- First release: a Manifest V3 extension for synced Netflix watch parties (play, pause, seek, server-clock
  sync), text chat and peer-to-peer voice chat, with a small WebSocket sync server (Node, then a Cloudflare
  Worker + Durable Object).

[1.9.0]: https://github.com/velvetthunder15/netparty/compare/c76cd9c...HEAD
[1.8.1]: https://github.com/velvetthunder15/netparty/commit/c76cd9c
[1.8.0]: https://github.com/velvetthunder15/netparty/commit/2868f10
[1.7.1]: https://github.com/velvetthunder15/netparty/commit/181acb5
[1.7.0]: https://github.com/velvetthunder15/netparty/commit/b50670c
[1.6.0]: https://github.com/velvetthunder15/netparty/commit/5df6623
[1.5.0]: https://github.com/velvetthunder15/netparty/commit/f154836
[1.4.2]: https://github.com/velvetthunder15/netparty/commit/2b09d5a
[1.4.1]: https://github.com/velvetthunder15/netparty/commit/978a2aa
[1.4.0]: https://github.com/velvetthunder15/netparty/commit/baf93a1
[1.3.1]: https://github.com/velvetthunder15/netparty/commit/9e04161
[1.3.0]: https://github.com/velvetthunder15/netparty/commit/1052934
[1.2.0]: https://github.com/velvetthunder15/netparty/commit/0b7093d
[1.1.0]: https://github.com/velvetthunder15/netparty/commit/4dbd631
[1.0.0]: https://github.com/velvetthunder15/netparty/commit/fe04ff1
