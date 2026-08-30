#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const TASKS = [
  { name: "heartbeat", intervalMs: 30_000 },
  { name: "email-delivery", intervalMs: 30_000 },
  { name: "provider-canary", intervalMs: 30_000, skip: "RELAY_SKIP_CANARY_SCHEDULER" },
  { name: "commercial-monitor", intervalMs: 60_000, skip: "RELAY_SKIP_COMMERCIAL_MONITOR" },
  { name: "account-check", intervalMs: 60_000, skip: "RELAY_SKIP_ACCOUNT_CHECK_SCHEDULER" },
  { name: "inspection-cleanup", intervalMs: 5 * 60_000 },
  { name: "availability-snapshot", intervalMs: 60 * 60_000, skip: "RELAY_SKIP_ACCOUNT_ANALYTICS" },
  { name: "plan-renewal", intervalMs: 60 * 60_000, skip: "RELAY_SKIP_PLAN_RENEWAL" },
  { name: "data-retention", intervalMs: 24 * 60 * 60_000, skip: "RELAY_SKIP_RETENTION" },
];

export function dueSchedulerTasks(lastRun, now = Date.now(), env = process.env) {
  return TASKS.filter((task) => env[task.skip] !== "1" && now - Number(lastRun[task.name] || 0) >= task.intervalMs)
    .map((task) => task.name);
}

export async function runSchedulerTask(name) {
  if (name === "heartbeat") {
    const sql = await (await import("../src/lib/db.ts")).getSql();
    await sql.query(
      `insert into relay_meta(key,value,updated_at) values ('scheduler_last_beat',$1,now())
       on conflict(key) do update set value=excluded.value,updated_at=now()`,
      [new Date().toISOString()],
    );
    return true;
  }
  if (name === "email-delivery") return (await import("../src/lib/email-outbox.ts")).deliverDueEmailNotifications();
  if (name === "provider-canary") return (await import("../src/lib/provider-canary-scheduler.ts")).tickProviderCanaries();
  if (name === "commercial-monitor") return (await import("../src/lib/commercial-monitor.ts")).tickCommercialMonitor();
  if (name === "account-check") return (await import("../src/lib/account-check-scheduler.ts")).tickAccountCheckScheduler();
  if (name === "inspection-cleanup") return (await import("../src/lib/account-inspections.ts")).expireAccountInspections();
  if (name === "availability-snapshot") return (await import("../src/lib/account-analytics.ts")).captureAvailabilitySample();
  if (name === "plan-renewal") return (await import("../src/lib/plan-renewal-scheduler.ts")).tickPlanRenewals();
  if (name === "data-retention") return (await import("../src/lib/data-retention.ts")).runDataRetention();
  throw new Error("SCHEDULER_TASK_UNKNOWN");
}

function safeError(error) {
  return (error instanceof Error ? error.message : "SCHEDULER_TASK_FAILED")
    .split(":", 1)[0].replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

export async function runSchedulerLoop(opts = {}) {
  const delay = opts.delay || ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)));
  const now = opts.now || Date.now;
  const run = opts.run || runSchedulerTask;
  const env = opts.env || process.env;
  const shouldStop = opts.shouldStop || (() => false);
  const lastRun = {};
  while (!shouldStop()) {
    const at = now();
    const due = dueSchedulerTasks(lastRun, at, env);
    for (const name of due) lastRun[name] = at;
    const results = await Promise.allSettled(due.map((name) => run(name)));
    results.forEach((result, index) => {
      if (result.status === "rejected") console.error(JSON.stringify({ source: "relay-scheduler", task: due[index], ok: false, error: safeError(result.reason) }));
    });
    await delay(30_000);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });
  await runSchedulerLoop({ shouldStop: () => stopping });
}
