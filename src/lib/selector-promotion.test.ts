import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeSelectorPack,
  candidateSelectorPack,
  recordSelectorCanary,
  resetSelectorPromotionForTests,
  setCandidateSelectorPack,
} from "./selector-promotion.ts";
import { nextCanaryDelay, parseInterval, realImageCanaryMs, isPaidImageCanary } from "./provider-canary-scheduler.ts";

test("candidate pack promotes after 3 consecutive passes and rolls back on fail", () => {
  resetSelectorPromotionForTests();
  const prev = activeSelectorPack("chatgpt");
  setCandidateSelectorPack("chatgpt", "chatgpt-v2");
  assert.equal(candidateSelectorPack("chatgpt"), "chatgpt-v2");
  assert.equal(recordSelectorCanary("chatgpt", "chatgpt-v2", true).promoted, false);
  assert.equal(recordSelectorCanary("chatgpt", "chatgpt-v2", true).promoted, false);
  const third = recordSelectorCanary("chatgpt", "chatgpt-v2", true);
  assert.equal(third.promoted, true);
  assert.equal(activeSelectorPack("chatgpt"), "chatgpt-v2");
  assert.equal(candidateSelectorPack("chatgpt"), null);

  resetSelectorPromotionForTests();
  setCandidateSelectorPack("chatgpt", "chatgpt-v2");
  recordSelectorCanary("chatgpt", "chatgpt-v2", true);
  const fail = recordSelectorCanary("chatgpt", "chatgpt-v2", false);
  assert.equal(fail.rolledBack, true);
  assert.equal(activeSelectorPack("chatgpt"), prev);
  assert.equal(candidateSelectorPack("chatgpt"), null);
});

test("structural vs paid image canary intervals", () => {
  process.env.REAL_IMAGE_CANARY_INTERVAL = "3h";
  assert.equal(parseInterval("3h"), 3 * 3600_000);
  assert.equal(realImageCanaryMs(), 3 * 3600_000);
  const delay = nextCanaryDelay(7 * 60_000, 0.2, 0.5);
  assert.ok(delay >= 7 * 60_000 * 0.8 && delay <= 7 * 60_000 * 1.2);
  assert.equal(isPaidImageCanary("chatgpt", "paid"), false);
  assert.equal(isPaidImageCanary("leonardo", "paid"), true);
  assert.equal(isPaidImageCanary("gemini", "structural"), false);
});
