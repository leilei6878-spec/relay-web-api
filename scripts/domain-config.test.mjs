import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("production Caddy binds ai8 HTTPS to Relay with a complete image timeout budget", () => {
  const caddy = readFileSync("deploy/Caddyfile.ai8", "utf8");
  const vite = readFileSync("vite.config.ts", "utf8");
  assert.match(caddy, /ai8\.itark\.cn\s*\{/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8088/);
  assert.match(caddy, /header_up X-Real-IP \{remote_host\}/);
  assert.match(caddy, /header_up X-Forwarded-Proto \{scheme\}/);
  assert.match(caddy, /response_header_timeout 360s/);
  assert.match(caddy, /read_timeout 360s/);
  assert.match(caddy, /write_timeout 360s/);
  assert.match(caddy, /Strict-Transport-Security/);
  assert.match(caddy, /http:\/\/38\.175\.201\.137\s*\{[\s\S]*redir https:\/\/ai8\.itark\.cn\{uri\} permanent/);
  assert.doesNotMatch(caddy, /127\.0\.0\.1:3000|nip\.io|webai/i);
  assert.match(vite, /allowedHosts:\s*\["ai8\.itark\.cn"\]/);
  assert.doesNotMatch(vite, /allowedHosts:[^\n]*nip\.io/);
});
