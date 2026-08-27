import assert from "node:assert/strict";
import { test } from "node:test";
import { resetCoordForTests } from "./coord.ts";
import { featuresFromWorker, processStructuralCanaryResult } from "./canary-result.ts";
import {
  activeSelectorPack,
  candidateSelectorPack,
  resetSelectorPromotionForTests,
} from "./selector-promotion.ts";

test("worker fingerprint strings become DOM features", () => {
  assert.deepEqual(featuresFromWorker({ features: ["input:1", "send:0"] }), [
    { key: "input", present: true },
    { key: "send", present: false },
  ]);
});

test("DOM failure proposes fallback and 3 candidate passes promote", async () => {
  resetCoordForTests();
  await resetSelectorPromotionForTests();
  await processStructuralCanaryResult({
    provider: "chatgpt",
    selectorPackVersion: "chatgpt-v1",
    ok: false,
    error: "PROVIDER_DOM_CHANGED",
    errorCode: "PROVIDER_DOM_CHANGED",
  });
  assert.equal(await candidateSelectorPack("chatgpt"), "chatgpt-v2");
  for (let i = 0; i < 3; i += 1) {
    await processStructuralCanaryResult({
      provider: "chatgpt",
      selectorPackVersion: "chatgpt-v2",
      ok: true,
      fingerprint: { features: ["input:1", "send:1", "assistant:1"] },
    });
  }
  assert.equal(await activeSelectorPack("chatgpt"), "chatgpt-v2");
  assert.equal(await candidateSelectorPack("chatgpt"), null);
});
