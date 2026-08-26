#!/bin/sh
set -eu
cd /app
npm run db:migrate
exec node scripts/with-app-env.mjs vite preview --host 0.0.0.0 --port 8080
