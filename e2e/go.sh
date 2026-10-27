#!/bin/bash
# usage: [SCRIPT=lifecycle.mjs] [SITE=...] [HOT=1] [CSP=strict] ./go.sh   -> output in run.log (or $LOG)
export PATH=/workspace/work/tools/node-v24.22.1-linux-arm64/bin:$PATH
cd /workspace/work/e2e
[ -x /usr/bin/chromium ] && fc-list | grep -qi "color emoji" || { sudo apt-get update -qq >/dev/null 2>&1; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chromium fonts-noto-color-emoji >/tmp/apt.log 2>&1; }
pkill -f "node server.js"; pkill -f fakesite.mjs
sleep 0.3
node fakesite.mjs > fake.log 2>&1 &
F=$!
(cd /workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/server && PORT=8787 exec node server.js > /tmp/np-server.log 2>&1) &
S=$!
sleep 1.5
LOG=${LOG:-run.log}
SITE=${SITE:-https://www.netflix.com/watch/12345} timeout ${TMO:-230} node ${SCRIPT:-run.mjs} > $LOG 2>&1
echo "exit $?" >> $LOG
kill $F $S
