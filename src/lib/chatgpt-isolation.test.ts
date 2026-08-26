import assert from "node:assert/strict";
import test from "node:test";
import { localWorkerScript } from "./local-worker-script";

test("conversation_isolation_test uses temporary chat plus new-chat js click", () => {
  const s = localWorkerScript();
  assert.match(s, /temporary-chat=true/);
  assert.match(s, /js_new_chat/);
  assert.match(s, /create-new-chat-button/);
});

test("send failure does not wait 30 seconds", () => {
  const s = localWorkerScript();
  assert.match(s, /SEND_NOT_ACKED/);
  assert.match(s, /SEND_ACK_TIMEOUT = 4000/);
  assert.equal(s.includes("box.click()"), false);
});
