import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { localWorkerScript } from "./local-worker-script";

test("worker uses staged timeouts instead of 30s clicks", () => {
  const s = localWorkerScript();
  assert.match(s, /PAGE_READY_TIMEOUT = 8000/);
  assert.match(s, /COMPOSER_READY_TIMEOUT = 4000/);
  assert.match(s, /INPUT_TIMEOUT = 1000/);
  assert.match(s, /SEND_BUTTON_TIMEOUT = 1500/);
  assert.match(s, /SEND_ACK_TIMEOUT = 4000/);
  assert.match(s, /install_mut_observer/);
  assert.match(s, /btn.click\(timeout=1500/);
  assert.match(s, /insert_text/);
  assert.match(s, /Instant/);
  assert.match(s, /has_images else 18/);
  assert.match(s, /usable_assistant_text/);
  assert.match(s, /Analyzing image/);
});

test("worker streams deltas and records T0-T10", () => {
  const s = localWorkerScript();
  assert.match(s, /mark\("T8"\)/);
  assert.match(s, /mark\("T10"\)/);
  assert.match(s, /submit_to_first_delta_ms/);
  assert.match(s, /actual_profile/);
  assert.match(s, /fast_capable/);
  assert.equal(/if text and not phase:\s+return/.test(s), false);
  assert.match(s, /post_chunk\(piece/);
});

test("worker script on disk matches template", () => {
  const disk = readFileSync("workers/relay-worker.py", "utf8");
  assert.match(disk, /PAGE_READY_TIMEOUT = 8000/);
});
