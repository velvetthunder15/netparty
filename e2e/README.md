# Browser end-to-end test

Two real Chromium profiles with the extension loaded, a fake Netflix/JioHotstar watch page
(router strips query params, hotkeys swallow Space/Enter like the real sites), and the local server.
Checks: split-screen layout, start party → invite page → join → chat via Enter and the Send button → pause/seek sync.

```bash
cd e2e && npm i playwright
ffmpeg -f lavfi -i testsrc=size=640x360:rate=25 -t 120 -c:v libvpx test.webm
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 \
  -subj "/CN=www.netflix.com" -addext "subjectAltName=DNS:www.netflix.com,DNS:www.hotstar.com"
node fakesite.mjs &   (cd ../server && PORT=8787 node server.js &)
node run.mjs          # SITE=https://www.hotstar.com/in/shows/x/1/watch node run.mjs for JioHotstar
```
Set `executablePath` in run.mjs to your Chromium.
