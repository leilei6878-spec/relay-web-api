#!/bin/sh
set -eu
cd /workspace
node scripts/preview.mjs stop || true
if [ -x /workspace/bin/sing-box ] && [ -f /workspace/storage/sing-box.json ]; then
  if ! python3 -c "import socket;s=socket.create_connection(('127.0.0.1',10808),1);s.close()" 2>/dev/null; then
    /workspace/bin/sing-box run -c /workspace/storage/sing-box.json >>/tmp/sing-box.log 2>&1 &
  fi
fi
if ! curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  npm run dev >>/tmp/app-startup.log 2>&1 &
  i=0
  while [ "$i" -lt 40 ]; do
    if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8080/; then
      break
    fi
    i=$((i + 1))
    sleep 0.5
  done
fi
node --experimental-strip-types --no-warnings scripts/bootstrap-runtime.mjs >/tmp/relay-api-key.txt
TOKEN=$(cat /tmp/relay-api-key.txt | tail -n 1)
fuser -k 18765/tcp >/dev/null 2>&1 || true
RELAY_HEADLESS=1 RELAY_TEST_URL=self RELAY_WORKER_PORT=18765 \
  RELAY_GATEWAY=http://127.0.0.1:8080 RELAY_TOKEN="$TOKEN" RELAY_WORKER_NAME=preview \
  python3 /workspace/storage/worker.py >>/tmp/relay-worker.log 2>&1 &
