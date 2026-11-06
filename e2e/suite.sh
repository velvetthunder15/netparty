#!/bin/bash
# runs several go.sh jobs one after another: ./suite.sh "SCRIPT=lifecycle.mjs LOG=nf.log" "SCRIPT=lifecycle.mjs HOT=1 LOG=hs.log"
set -e
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
for job in "$@"; do env $job ./go.sh; done
echo all-done > suite.done
