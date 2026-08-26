import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyError, isAccountFault } from "./faults.ts";

test("fault taxonomy maps provider/account/proxy/worker", () => {
  assert.equal(classifyError("SESSION_INVALID: login wall"), "account");
  assert.equal(classifyError("BANNED"), "account");
  assert.equal(classifyError("PROXY_UNAVAILABLE"), "proxy");
  assert.equal(classifyError("DOM_CHANGED: composer"), "provider");
  assert.equal(classifyError("MODEL_MISMATCH"), "provider");
  assert.equal(classifyError("WORKER_DEAD"), "worker");
  assert.equal(classifyError("TIMEOUT: wait"), "worker");
  assert.equal(isAccountFault("account"), true);
  assert.equal(isAccountFault("infra"), false);
});
