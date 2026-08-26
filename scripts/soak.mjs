#!/usr/bin/env node
/**
 * Soak harness. Default 60s smoke. Set RELAY_SOAK=1h|12h|24h|48h for long runs.
 */
const base = process.env.RELAY_TEST_BASE || "http://127.0.0.1:8080";
const map = { smoke: 60_000, "1h": 3_600_000, "12h": 43_200_000, "24h": 86_400_000, "48h": 172_800_000 };
const windowMs = process.env.RELAY_SOAK_MS
  ? Number(process.env.RELAY_SOAK_MS)
  : map[process.env.RELAY_SOAK || "smoke"] || 60_000;
const started = Date.now();
let ok = 0;
let fail = 0;
const lat = [];

function pct(p) {
  if (!lat.length) return 0;
  const s = [...lat].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

while (Date.now() - started < windowMs) {
  const t0 = Date.now();
  try {
    const session = await fetch(base + "/api/admin/session");
    const runtime = await fetch(base + "/api/runtime");
    const metrics = await fetch(base + "/api/admin/metrics");
    const invoke = await fetch(base + "/api/admin/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "/v1/chat/completions",
        payload: { model: "gpt-5.6", messages: [{ role: "user", content: "ping" }] },
      }),
    });
    const good = session.ok && runtime.ok && metrics.status !== 500 && invoke.status !== 500;
    if (good) ok += 1;
    else fail += 1;
  } catch {
    fail += 1;
  }
  lat.push(Date.now() - t0);
  await new Promise((r) => setTimeout(r, 250));
}

const report = {
  windowMs,
  ok,
  fail,
  successRate: ok + fail ? ok / (ok + fail) : 0,
  p50: pct(50),
  p95: pct(95),
  p99: pct(99),
  at: new Date().toISOString(),
};
console.log(JSON.stringify(report, null, 2));
if (report.successRate < 0.95) process.exitCode = 1;
