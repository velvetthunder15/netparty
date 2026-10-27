# Firefox end-to-end tests

Real Firefox ESR (153) driven over WebDriver BiDi with puppeteer-core. The AMO build (unpacked from
`netparty-firefox-<ver>.zip`) is installed as a temporary add-on. The fake sites from `../fakesite.mjs` are reached
through a local CONNECT proxy (`fflib.mjs`, port 8899), and the local server through a TLS recording proxy
(`tapTLS`, wss://localhost:8792). Firefox's MV3 extension CSP has `upgrade-insecure-requests`, so the add-on
only speaks wss://, just like with netparty.tech.

| Script | Checks |
| --- | --- |
| `ffrun.mjs` | install + data-collection grant, start party, invite page, join via link (#key stripped), encrypted chat both ways, play/pause/seek sync both ways (page.js bridge), 🎉 reactions, panel Copy invite → clipboard, popup in-party view + avatar change, voice (fake mic, WebRTC in the content script), reloads (key from storage.session), leave/end, WebSocket leak audit. `SITE=` for JioHotstar/YouTube, `IDLE=<ms>` sets `extensions.background.idle.timeout`, `QUIET=<s>` idles mid-test and counts socket restarts |
| `ffpopup.mjs` | popup Start a party (link really on the clipboard) and Join by pasting the invite link |
| `ffcross.mjs` | Firefox host + Chromium guest: join, chat both ways, sync both ways, voice |
| `ffgif.mjs` | background GIF API fetch (CORS for moz-extension://) and KLIPY media, GIF picker renders |
| `ffprod.mjs` | against the live wss://netparty.tech: create, prod invite page, join, chat both ways, sync, end |
| `ffprodgif.mjs` | against the live netparty.tech: GIF search/trending and a KLIPY image from the add-on's moz-extension:// origin |

```bash
sudo apt-get install -y firefox-esr chromium
mkdir -p /workspace/work/ff && cd /workspace/work/ff && npm i puppeteer-core web-ext
node netparty/scripts/build-firefox.mjs --dir /workspace/work/ff/build
# start ../fakesite.mjs (CSP=script for a strict page script-src) and server.js on :8787, then:
node ffrun.mjs; IDLE=25000 QUIET=75 node ffrun.mjs; SITE="https://www.youtube.com/watch?v=aaaaaaaaaaa" node ffrun.mjs
node ffpopup.mjs; node ffcross.mjs; node ffgif.mjs
npx web-ext lint -s /workspace/work/ff/build
```
