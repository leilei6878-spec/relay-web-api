#!/bin/sh
set -eu
cd /app
if [ ! -f workers/relay-worker.py ]; then
  node --experimental-strip-types scripts/export-worker.mjs workers/relay-worker.py
fi
export RELAY_HEADLESS="${RELAY_HEADLESS:-1}"
export RELAY_GATEWAY="${RELAY_GATEWAY:-http://gateway:8080}"
export RELAY_TOKEN="${RELAY_TOKEN:-$RELAY_WORKER_TOKEN}"
export RELAY_WORKER_NAME="${RELAY_WORKER_NAME:-worker-1}"
export RELAY_CAPACITY="${RELAY_CAPACITY:-$MAX_WORKER_CONCURRENCY}"
export RELAY_CAPACITY="${RELAY_CAPACITY:-3}"
exec python3 workers/relay-worker.py
