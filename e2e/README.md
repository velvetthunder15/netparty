# Browser end-to-end tests

Two real Chromium profiles with the extension loaded, fake Netflix / JioHotstar / YouTube pages
(routers strip query params, hotkeys swallow Space/Enter/k/j/l like the real sites, the fake YouTube
enforces Trusted Types, is an SPA with `yt-navigate-finish`, theater/fullscreen and ads), a mock KLIPY
API (`http://127.0.0.1:8444`) and mock KLIPY media host (`static.klipy.com`), and the local server.

| Script | Checks |
| --- | --- |
| `run.mjs` | split-screen layout, start party → invite page (key in `#k=`, host named by the page) → join → chat via Enter and Send → pause/seek sync, reloads (decrypted history survives); WebSocket frames recorded by a proxy contain no names, messages or key |
| `lifecycle.mjs` | Start a NetParty button, next episode keeps the party (chat still decrypts), leaving ends/leaves it (`HOT=1` for JioHotstar) |
| `features.mjs` | avatars, emoji picker, 🎉 reactions (rate limit, edit, fullscreen), text size, links, GIFs (no key → unavailable; mock KLIPY → search/chips/attribution/send), popup, voice over encrypted signaling, reload keeps decryption, bare code / missing / malformed / wrong key messages, and a leak audit of every WebSocket frame (names, pictures, messages, GIF URLs, reactions, reply quotes and message reactions (2.1), SDP/ICE, key, cids). `CSP=strict` makes the fake Netflix send `img-src 'self' blob:` so GIFs go through the blob: fallback |
| `prime.mjs` | fake Prime Video (`www.primevideo.com`, `www.amazon.co.uk/gp/video`: overlay player `#dv-web-player`, muted hero trailer, `?autoplay=1`): start button next to Play, invite → join (autoplay opens the guest's player), sync both ways through the player's `<video>` (never the trailer), Prime ad countdown pauses sync, dock narrows the fixed player, title change, closing the player leaves/ends, popup site detection |
| `v18.mjs` | own messages show your picture + name, themes (System follows `prefers-color-scheme`, Light/Dark override, persisted in the popup), WCAG contrast audit of every visible text in panel/pickers/voice/camera strip/toast/popup in both themes, video chat between two Chromium browsers (and a third for 3 cameras) with fake cameras (live frames both ways, 640x360 ≤24 fps; 1.9: docked in the panel by default with tiles filling most of it at 1280–1920 in both themes, chat keeps 4 lines, no overflow; chat closed → floating; pop out, collapse, drag anywhere + clamp, resize by mouse and keys, dock back by keyboard, fullscreen, remembered across a reload, clicks on tiles never reach the page; camera off, leaving voice), "Your profile" name field (Enter/blur save, empty ignored, Esc, 24 chars, the other peer sees it), SDP/camera state never in plaintext, camera permission denied, HiDPI (2x/3x: no upscaled raster images) |
| `anyvideo.mjs` | 2.0 "Sync any video" on local test pages (`anysite.mjs`, two origins: `http://localhost:8450` and `:8451`): popup Sync this tab, invite page decrypts the page address (and refuses javascript:/data:/file:/credentials/markup), Open the video → popup Join party on this tab, play/pause/seek/speed sync both ways within 1 s, drift closed by speed nudges or a hard seek, the site swapping the `<video>`, Theater, open shadow root, same-origin iframe, cross-origin iframe (Allow, and a refused prompt), two videos (picker), duration mismatch → Open host's page, live stream, canvas-only page, Always allow (registered scripts, reload keeps the party), leak audit. activeTab can't be granted by automation: the suite loads a test copy of the extension with `http://localhost/*` in `host_permissions` instead (see the file header). Needs `test-short.webm` (60 s) next to `test.webm` |
| `chat2.mjs` | 2.1 chat: reply (hover / touch-tap action bar, strip with Esc / × cancel, quote on both sides, click jumps to and highlights the original, reply to a GIF says "GIF"), reactions on messages (quick row, chips with counts / mine highlight / who reacted, toggle, "+" opens the emoji picker with search), lines from a 2.0.x sender (no message id) can be replied to and reacted to, bad or dangling reactions ignored, replies and reactions survive a reload (history replay), emoji search (filter across categories, keywords, several words, no duplicates, "No emoji found", Esc clears then closes, Enter inserts at the caret), site hotkeys never fire, a 2.0.2 browser (extension from git) shows replies as plain messages and no reaction lines, leak audit (no snippet, emoji, name or message in any frame). Also `CSP=strict` |
| `chat3.mjs` | 2.2 (fake Netflix; host, two guests, a real 2.1.0 build from git, a scripted member, and a 2.0.2 build joining late): typing indicator (one / "2 people", ≤ 1 signal per 3 s, expires after 5 s, cleared by the line), @mentions (list on "@", word-start filter, Enter / Tab, names with spaces, typed mentions, highlight + "mentioned you" toast + "@" badge, rename updates old mentions, pid in the payload), spoilers (`||…||` and the Spoiler switch, blurred until tapped per viewer, "[spoiler]" for old clients, replies quote "Spoiler"), edit / delete (own lines only, "(edited)" / "Message deleted", forged edits and deletes ignored, history replay, no garbage on 2.1.0 / 2.0.2), pinned message (bar, jump, unpin, host-only, persists across reloads, spoiler pins, deleted pin hides), panel + popup settings, buffer-aware sync with a really stalled video (`/gate.webm`: wait, resume together from the same moment, play over it, switched off, 20 s timeout + note), pause on drop (reload within grace auto-resumes, closed tab → Resume button), auto-duck (fake mic tone: 30 %, smooth, exact restore, your own change wins, leave voice, switched off), leak audit (frames + server log). Also `CSP=strict` |
| `platforms.mjs` | 2.2 HBO Max / Crunchyroll / SonyLIV and 2.4 Hulu / Disney+ / Paramount+ / STARZ / Tubi on FIXTURES (fakesite.mjs pages built from the services' public URL shapes and page structure; the real services aren't tested): popup detection, watch-page ids, start, invite page + link, join, sync both ways (Crunchyroll through its player iframe), ads, title, chat, dock, next episode, popup site list |
| `live.mjs` | 2.5 live streams (YouTube live, Twitch, Kick, Rumble) on FIXTURES fed by one fake broadcast (`livesim/`, 2 s WebM segments released in real time, played through Media Source Extensions; cookies set each browser's start delay, rewind window and snap-to-live): live ids and titles, invite page (2.5, no account), join, true sync by the stream's own time (Δ < 1.5 s) after joining closer to live and after the host falls behind, pause / play, a rewind followed (Rumble, YouTube) or not sent (Twitch, Kick), Go live, another stream, a player that snaps back to live left alone after two tries, chat, popup site detection, Rumble videos that aren't live |
| `avatars.mjs` | 2.2 profile pictures (fake Netflix; host, guest, a real 2.1.0 build from git, two guests whose pages send a strict image CSP, and a scripted member): the 48 bundled HD pictures (picker, panel, chat, voice tiles, popup), uploading your own photo (centre-cropped, WebP, size cap), the photo and HD picture only ever travel encrypted, the 2.1.0 build sees the emoji fallback, blob: / data: / `<canvas>` fallbacks when the page CSP refuses images, broken and hostile profiles ignored, never upscaled at 3x, leak audit (no photo, `av:` value or name in any frame). Also `CSP=strict` |
| `relaycreds.mjs` | 2.2 relay credential refresh: a recording proxy hands out a fresh fake TURN entry on every voiceJoin / voiceIce reply; a call uses the credentials from voiceJoin, they aren't re-fetched for every call, and after the socket drops the voice rejoin saves the new credentials and the reconnect calls use them |
| `youtube.mjs` | YouTube start button, invite → join (key in the fragment, stripped from the URL), encrypted chat, sync, ads, video change, dock geometry (default/theater/fullscreen), leaving |

`lib.mjs` has `tap(port, target)`: a recording WebSocket/HTTP proxy in front of the server, so the suites can check
exactly what the server receives and sends.

```bash
# From the repository root. Use Node.js 22+ and npm on Linux, macOS, or WSL.
# Install ffmpeg, openssl, git, tar, and an emoji font with your OS package manager.
npm --prefix server ci
npm --prefix e2e ci
npm --prefix e2e run browser:install
cd e2e
ffmpeg -f lavfi -i testsrc=size=640x360:rate=25 -t 120 -c:v libvpx test.webm
ffmpeg -f lavfi -i testsrc=size=320x180:rate=15 -t 60 -c:v libvpx -b:v 200k test-short.webm
ffmpeg -f lavfi -i testsrc=size=200x150:rate=5 -t 1.2 test.gif
# live.mjs: the fake broadcast, 15 minutes in 2 s WebM segments
mkdir -p livesim && ffmpeg -f lavfi -i testsrc=size=320x180:rate=25 -t 900 -c:v libvpx -b:v 120k -g 50 -keyint_min 50 -f dash -dash_segment_type webm \
  -seg_duration 2 -use_template 1 -use_timeline 0 -init_seg_name init.webm -media_seg_name 'seg-$Number$.webm' livesim/live.mpd
# chat3.mjs (tone.wav) and avatars.mjs / ffavatars.mjs (photo.png) generate their own inputs in MEDIA_DIR with ffmpeg
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 \
  -subj "/CN=www.netflix.com" -addext "subjectAltName=DNS:www.netflix.com,DNS:www.hotstar.com,DNS:www.youtube.com,DNS:static.klipy.com,DNS:www.primevideo.com,DNS:www.amazon.co.uk,DNS:play.hbomax.com,DNS:play.max.com,DNS:www.crunchyroll.com,DNS:static.crunchyroll.com,DNS:www.sonyliv.com,DNS:www.hulu.com,DNS:www.disneyplus.com,DNS:www.paramountplus.com,DNS:www.starz.com,DNS:tubitv.com,DNS:www.twitch.tv,DNS:kick.com,DNS:rumble.com"
./go.sh                                  # run.mjs (Netflix); SITE=https://www.hotstar.com/in/shows/x/1260000002/ep/1260000099/watch for JioHotstar
SCRIPT=lifecycle.mjs HOT=1 ./go.sh
SCRIPT=features.mjs ./go.sh; SCRIPT=features.mjs CSP=strict ./go.sh
SCRIPT=chat2.mjs TMO=300 ./go.sh
SCRIPT=chat3.mjs TMO=700 ./go.sh; CSP=strict SCRIPT=chat3.mjs TMO=700 ./go.sh
SCRIPT=platforms.mjs TMO=400 ./go.sh
SCRIPT=live.mjs TMO=900 ./go.sh
SCRIPT=avatars.mjs TMO=600 ./go.sh; CSP=strict SCRIPT=avatars.mjs TMO=600 ./go.sh
SCRIPT=relaycreds.mjs TMO=300 ./go.sh
SCRIPT=youtube.mjs ./go.sh
SCRIPT=anyvideo.mjs TMO=420 ./go.sh
SCRIPT=prime.mjs ./go.sh; SCRIPT=v18.mjs TMO=300 ./go.sh
```
Run `e2e/go.sh` from any working directory. It uses Node from `PATH`; set `NODE` to
an executable path to choose another installation. `npm --prefix e2e test` is equivalent.
No OS packages are installed by the runner. On Linux, if Chromium reports missing system
libraries, install them using your OS package manager or `cd e2e && npx playwright install-deps chromium`.

Playwright and `ws` are declared in `e2e/package.json` and pinned by its lockfile.
The default browser is Playwright's full Chromium build, including headless extension support.
Set `CHROMIUM_PATH=/absolute/path/to/chromium` to use another Chromium build that supports
loading unpacked extensions. Chrome and Edge builds may disable these extension flags.

| Setting | Default / meaning |
| --- | --- |
| `SCRIPT` | `run.mjs`; relative paths resolve from `e2e`, absolute paths also work |
| `TMO` | `230` seconds; positive number, timeout returns exit code 124 |
| `LOG` | `e2e/run.log`; relative paths resolve from `e2e` |
| `EXT_DIR` | This checkout's `extension` directory |
| `MEDIA_DIR` | `e2e`; directory containing generated media and TLS certificate/key |
| `SERVER_LOG` | `e2e/server.log`; also used by the server-log leak assertions |
| `OLD_REV` | Full commit `52ed7690633fbc2f6f4a343aa2a724596bebc800` (2.0.2) for `chat2.mjs` |
| `OLD21` / `OLD20` | Full commits `761eb86e27cdb44e46c423e4607b8de073fe1f30` (2.1.0) and `52ed7690633fbc2f6f4a343aa2a724596bebc800` (2.0.2): the old clients in `chat3.mjs` (both) and `avatars.mjs` (`OLD21`) |

Use absolute paths for path overrides when invoking `go.sh` outside `e2e`. `SITE`, `HOT`,
`CSP`, and the other suite-specific settings still work. `SERVER` is for manually managed
runs; `go.sh` always starts the local server on port 8787 because the recording proxies
assert against that server.

The chat compatibility test requires Git history containing `OLD_REV`, plus `git` and `tar`
on `PATH`. For a shallow clone, fetch that commit or unshallow the clone first. A missing
old client is an error, never a skipped compatibility check. Archive commands use argument
arrays so checkout paths with spaces work.

The runner checks files, dependencies, browser installation, and the suite's fixed ports
before starting. Run one suite at a time per host: ports 8443, 8444, 8450, 8451, 8787, 8789,
8790, 8791, 8792, 8793, 8794, 8796, and 8899 must be free. A busy port causes an error without
stopping its owner. Service startup is checked before the test starts.

Each run owns separate process groups and a private temporary directory for browser profiles
and extension copies. Success, failure, timeout, Ctrl+C, and SIGTERM all trigger cleanup of
those groups only. No `pkill` or process-name matching is used. Native Windows is not supported
by this POSIX cleanup code; use WSL. SIGKILL cannot be handled. Logs and screenshots remain in
`e2e`; temporary profiles are removed. The command returns the test's status (130 for Ctrl+C,
143 for SIGTERM). Inspect `fake.log`, `server.log`, and the chosen test log on failure.

Run the runner regression checks without browsers or media:

```bash
npm --prefix e2e run test:runner
```

Optional tools: `store-capture.mjs` reads `still-<n>.b64` from `STORE_DIR` (default `e2e/store`)
and writes to its `raw` subdirectory. `relay.mjs` reads `ICE_FILE` (default `ice.json` in the
working directory) and leaves that input file intact. See `firefox/README.md` for Firefox setup.
