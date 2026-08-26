type Sample = { at: number; latencyMs: number; ok: boolean; platform?: string };

const samples: Sample[] = [];
const MAX = 5000;

export function observeCall(row: { latencyMs: number; ok: boolean; platform?: string }) {
  samples.push({ at: Date.now(), latencyMs: row.latencyMs, ok: row.ok, platform: row.platform });
  if (samples.length > MAX) samples.splice(0, samples.length - MAX);
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function metricsSnapshot(windowMs = 3_600_000) {
  const from = Date.now() - windowMs;
  const rows = samples.filter((s) => s.at >= from);
  const lat = rows.map((s) => s.latencyMs).sort((a, b) => a - b);
  const ok = rows.filter((s) => s.ok).length;
  return {
    windowMs,
    count: rows.length,
    successRate: rows.length ? ok / rows.length : 1,
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    p99: percentile(lat, 99),
  };
}
