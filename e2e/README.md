# Browser end-to-end tests

Two real Chromium profiles with the extension loaded, fake Netflix / JioHotstar / YouTube pages
(routers strip query params, hotkeys swallow Space/Enter/k/j/l like the real sites, the fake YouTube
enforces Trusted Types, is an SPA with `yt-navigate-finish`, theater/fullscreen and ads), a mock KLIPY
API (`http://127.0.0.1:8444`) and mock KLIPY media host (`static.klipy.com`), and the local server.

| Script | Checks |
| --- | --- |
| `run.mjs` | split-screen layout, start party → invite page (key in `#k=`, host named by the page) → join → chat via Enter and Send → pause/seek sync, reloads (decrypted history survives); WebSocket frames recorded by a proxy contain no names, messages or key |
| `lifecycle.mjs` | Start a NetParty button, next episode keeps the party (chat still decrypts), leaving ends/leaves it (`HOT=1` for JioHotstar) |
| `features.mjs` | avatars, emoji picker, 🎉 reactions (rate limit, edit, fullscreen), text size, links, GIFs (no key → unavailable; mock KLIPY → search/chips/attribution/send), popup, voice over encrypted signaling, reload keeps decryption, bare code / missing / malformed / wrong key messages, and a leak audit of every WebSocket frame (names, pictures, messages, GIF URLs, reactions, SDP/ICE, key, cids). `CSP=strict` makes the fake Netflix send `img-src 'self' blob:` so GIFs go through the blob: fallback |
| `youtube.mjs` | YouTube start button, invite → join (key in the fragment, stripped from the URL), encrypted chat, sync, ads, video change, dock geometry (default/theater/fullscreen), leaving |

`lib.mjs` has `tap(port, target)`: a recording WebSocket/HTTP proxy in front of the server, so the suites can check
exactly what the server receives and sends.

```bash
cd e2e && npm i playwright
ffmpeg -f lavfi -i testsrc=size=640x360:rate=25 -t 120 -c:v libvpx test.webm
ffmpeg -f lavfi -i testsrc=size=200x150:rate=5 -t 1.2 test.gif
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 \
  -subj "/CN=www.netflix.com" -addext "subjectAltName=DNS:www.netflix.com,DNS:www.hotstar.com,DNS:www.youtube.com,DNS:static.klipy.com"
./go.sh                                  # run.mjs (Netflix); SITE=https://www.hotstar.com/in/shows/x/1260000002/ep/1260000099/watch for JioHotstar
SCRIPT=lifecycle.mjs HOT=1 ./go.sh
SCRIPT=features.mjs ./go.sh; SCRIPT=features.mjs CSP=strict ./go.sh
SCRIPT=youtube.mjs ./go.sh
```
Paths to Chromium, Playwright and the extension are set at the top of `lib.mjs` / the scripts.
