# Firefox end-to-end tests

Real Firefox ESR (153) driven over WebDriver BiDi with puppeteer-core. The AMO build (unpacked from
`netparty-firefox-<ver>.zip`) is installed as a temporary add-on. The fake sites from `../fakesite.mjs` are reached
through a local CONNECT proxy (`fflib.mjs`, port 8899), and the local server through a TLS recording proxy
(`tapTLS`, wss://localhost:8792). Firefox's MV3 extension CSP has `upgrade-insecure-requests`, so the add-on
only speaks wss://, just like with netparty.tech.

| Script | Checks |
| --- | --- |
| `ffrun.mjs` | install + data-collection grant, start party, invite page, join via link (#key stripped), encrypted chat both ways, play/pause/seek sync both ways (page.js bridge), 🎉 reactions, panel Copy invite → clipboard, popup in-party view + avatar change, voice (fake mic, WebRTC in the content script), reloads (key from storage.session), leave/end, WebSocket leak audit. `SITE=` for JioHotstar/YouTube, `IDLE=<ms>` sets `extensions.background.idle.timeout`, `QUIET=<s>` idles mid-test and counts socket restarts |
| `ffany.mjs` | 2.0 "Sync any video" in Firefox on the local test pages (`../anysite.mjs`): popup Sync this tab, invite page, Open the video → Join party on this tab, sync both ways, speed, drift nudge, element swap, Theater, Always allow + reload, cross-origin iframe (Allow), picker, mismatch, live stream. Uses a test copy of the build with `http://localhost/*` in `host_permissions` in place of the activeTab grant |
| `ffpopup.mjs` | popup Start a party (link really on the clipboard) and Join by pasting the invite link |
| `ffcross.mjs` | Firefox host + Chromium guest: join, chat both ways, sync both ways, voice, camera tiles both ways (1.8) |
| `ffavatars.mjs` | 2.2 profile pictures: Firefox host (fake Netflix with a strict image CSP, `NPIMG=none` for `img-src 'self'`, `NPIMG=data` to add `data:`) and a Chromium guest: HD pictures and uploaded photos both ways (createImageBitmap + WebP encoding in Firefox), shown from blob: URLs despite the page CSP, leak audit |
| `ffgif.mjs` | background GIF API fetch (CORS for moz-extension://) and KLIPY media, GIF picker renders |
| `ffprod.mjs` | against the live wss://netparty.tech: create, prod invite page, join, chat both ways, sync, end |
| `ffprodgif.mjs` | against the live netparty.tech: GIF search/trending and a KLIPY image from the add-on's moz-extension:// origin |

Install Firefox ESR for your OS. Complete the media, certificate, server, and Playwright setup
in `../README.md`, then run these commands from the repository root:

```bash
npm --prefix e2e install --no-save puppeteer-core web-ext
node scripts/build-firefox.mjs --dir e2e/firefox/build
SCRIPT=firefox/ffrun.mjs ./e2e/go.sh
SCRIPT=firefox/ffrun.mjs IDLE=25000 QUIET=75 ./e2e/go.sh
SCRIPT=firefox/ffpopup.mjs ./e2e/go.sh
SCRIPT=firefox/ffcross.mjs ./e2e/go.sh
SCRIPT=firefox/ffgif.mjs ./e2e/go.sh
SCRIPT=firefox/ffavatars.mjs ./e2e/go.sh; NPIMG=data SCRIPT=firefox/ffavatars.mjs ./e2e/go.sh
cd e2e && npx web-ext lint -s firefox/build
```

`BUILD` defaults to `e2e/firefox/build`. Set `FIREFOX_PATH` to your Firefox executable's
absolute path; otherwise `firefox-esr` is resolved from `PATH`. `MEDIA_DIR` and `CHROMIUM_PATH`
use the same settings as the Chromium suites. Profiles and test build copies use the runner's
private temporary directory. The `ffprod` scripts contact the live service; run them only
when that is intended.
