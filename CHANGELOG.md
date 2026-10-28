# Changelog

All notable changes to NetParty (the browser extension and its sync server) are in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are commit dates (IST).

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
