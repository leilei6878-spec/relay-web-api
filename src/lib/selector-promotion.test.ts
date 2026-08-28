import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeSelectorPack,
  candidateSelectorPack,
  recordSelectorCanary,
  resetSelectorPromotionForTests,
  setCandidateSelectorPack,
} from "./selector-promotion.ts";
import { claimCanaryDispatch, nextCanaryDelay, parseInterval, realImageCanaryMs, isPaidImageCanary, resetCanarySchedulerForTests, scheduleCanaries, tickProviderCanaries } from "./provider-canary-scheduler.ts";
import { resetCoordForTests } from "./coord.ts";
import { canaryModelFor } from "./provider/canary-run.ts";

test("candidate pack promotes after 3 consecutive passes and rolls back on fail", async () => {
  resetCoordForTests();
  await resetSelectorPromotionForTests();
  const prev = await activeSelectorPack("chatgpt");
  await setCandidateSelectorPack("chatgpt", "chatgpt-v2");
  assert.equal(await candidateSelectorPack("chatgpt"), "chatgpt-v2");
  assert.equal((await recordSelectorCanary("chatgpt", "chatgpt-v2", true)).promoted, false);
  assert.equal((await recordSelectorCanary("chatgpt", "chatgpt-v2", true)).promoted, false);
  const third = await recordSelectorCanary("chatgpt", "chatgpt-v2", true);
  assert.equal(third.promoted, true);
  assert.equal(await activeSelectorPack("chatgpt"), "chatgpt-v2");
  assert.equal(await candidateSelectorPack("chatgpt"), null);

  await resetSelectorPromotionForTests();
  await setCandidateSelectorPack("chatgpt", "chatgpt-v2");
  await recordSelectorCanary("chatgpt", "chatgpt-v2", true);
  const fail = await recordSelectorCanary("chatgpt", "chatgpt-v2", false);
  assert.equal(fail.rolledBack, true);
  assert.equal(await activeSelectorPack("chatgpt"), prev);
  assert.equal(await candidateSelectorPack("chatgpt"), null);
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

test("Leonardo canary selects a model verified on its assigned account", () => {
  const models = ["leonardo-gpt-image-2", "leonardo-gemini"];
  assert.equal(
    canaryModelFor("leonardo", { platform: "leonardo", availableModels: ["Nano Banana 2"] }, models),
    "leonardo-gemini",
  );
  assert.equal(
    canaryModelFor("leonardo", { platform: "leonardo", availableModels: ["GPT Image 2"] }, models),
    "leonardo-gpt-image-2",
  );
  assert.equal(
    canaryModelFor("leonardo", { platform: "leonardo", availableModels: [] }, models),
    "leonardo-gpt-image-2",
  );
});

test("only one gateway claims a provider canary window", async () => {
  resetCoordForTests();
  const now = 1_800_000;
  const [a, b] = await Promise.all([
    claimCanaryDispatch("gemini", "structural", now),
    claimCanaryDispatch("gemini", "structural", now),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
});

test("paid image due items dispatch a real paid canary instead of reporting a skip", async () => {
  resetCoordForTests();
  resetCanarySchedulerForTests();
  scheduleCanaries(0);
  const calls: string[] = [];
  const ran = await tickProviderCanaries(24 * 3_600_000, async (provider, kind) => {
    calls.push(`${provider}:${kind}`);
    return { ok: true as const, job: { id: `${provider}-${kind}` } as never };
  });
  assert.ok(calls.includes("gemini:paid"));
  assert.ok(calls.includes("leonardo:paid"));
  assert.equal(ran.filter((row) => row.kind === "paid").every((row) => row.dispatched && row.ok), true);
  assert.equal(ran.some((row) => /skipped/i.test(row.error || "")), false);
});
