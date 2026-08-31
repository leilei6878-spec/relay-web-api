import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dueSchedulerTasks, runSchedulerLoop } from "./commercial-scheduler.mjs";

test("dedicated scheduler runs every task at boot and respects independent intervals/skips", () => {
  const last = {};
  const initialAt = 100_000_000;
  const initial = dueSchedulerTasks(last, initialAt, {});
  assert.deepEqual(initial, [
    "heartbeat", "email-delivery", "provider-canary", "commercial-monitor", "account-check", "inspection-cleanup",
    "availability-snapshot", "plan-renewal", "privacy-closure", "data-retention",
  ]);
  for (const name of initial) last[name] = initialAt;
  assert.deepEqual(dueSchedulerTasks(last, initialAt + 29_999, {}), []);
  assert.deepEqual(dueSchedulerTasks(last, initialAt + 30_000, {}), ["heartbeat", "email-delivery", "provider-canary"]);
  assert.deepEqual(
    dueSchedulerTasks({}, initialAt, { RELAY_SKIP_COMMERCIAL_MONITOR: "1", RELAY_SKIP_PLAN_RENEWAL: "1" }),
    ["heartbeat", "email-delivery", "provider-canary", "account-check", "inspection-cleanup", "availability-snapshot", "privacy-closure", "data-retention"],
  );
});

test("scheduler loop isolates task failure and continues to the next cycle", async () => {
  let clock = 1_000_000;
  let cycles = 0;
  const ran = [];
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await runSchedulerLoop({
      now: () => clock,
      env: { RELAY_SKIP_CANARY_SCHEDULER: "1", RELAY_SKIP_ACCOUNT_CHECK_SCHEDULER: "1", RELAY_SKIP_ACCOUNT_ANALYTICS: "1", RELAY_SKIP_PLAN_RENEWAL: "1", RELAY_SKIP_PRIVACY_CLOSURE: "1", RELAY_SKIP_RETENTION: "1" },
      run: async (name) => { ran.push(name); if (cycles === 0) throw new Error("SAFE_TASK_FAILURE: must not leak detail"); },
      delay: async (ms) => { cycles += 1; clock += ms + 60_000; },
      shouldStop: () => cycles >= 2,
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(ran, ["heartbeat", "email-delivery", "commercial-monitor", "inspection-cleanup", "heartbeat", "email-delivery", "commercial-monitor"]);
});

test("production Compose keeps scheduler separate, persistent and without a published port", () => {
  const compose = readFileSync("docker-compose.production.yml", "utf8");
  const scheduler = compose.slice(compose.indexOf("  scheduler:"), compose.indexOf("  backup:"));
  assert.match(scheduler, /image: relay-gateway/);
  assert.match(scheduler, /RELAY_EXTERNAL_SCHEDULER: "1"/);
  assert.match(scheduler, /commercial-scheduler\.mjs/);
  assert.match(scheduler, /healthcheck:\s*\n\s+disable: true/);
  assert.match(scheduler, /restart: unless-stopped/);
  assert.doesNotMatch(scheduler, /ports:/);
  assert.match(compose, /gateway:[\s\S]*RELAY_EXTERNAL_SCHEDULER: "1"/);
  for (const path of [
    "src/lib/commercial-monitor.ts", "src/lib/data-retention.ts", "src/lib/plan-renewal-scheduler.ts",
    "src/lib/provider-canary-scheduler.ts", "src/lib/account-check-scheduler.ts",
    "src/lib/account-analytics.ts", "src/lib/account-inspections.ts",
  ]) assert.match(readFileSync(path, "utf8"), /RELAY_EXTERNAL_SCHEDULER/);
});
