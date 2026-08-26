import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ResilienceCounters = {
  request_total: number;
  success: number;
  failover: number;
  retry: number;
  duplicate_execution: number;
  lost_requests: number;
  stale_results: number;
  stale_rejected: number;
  queue_depth: number;
  active_leases: number;
  worker_restart: number;
  browser_crash: number;
  provider_circuit_open: number;
  latencies: number[];
  startedAt: string;
  updatedAt: string;
};

const FILE = resolve("storage", "resilience-metrics.json");

function empty(): ResilienceCounters {
  return {
    request_total: 0,
    success: 0,
    failover: 0,
    retry: 0,
    duplicate_execution: 0,
    lost_requests: 0,
    stale_results: 0,
    stale_rejected: 0,
    queue_depth: 0,
    active_leases: 0,
    worker_restart: 0,
    browser_crash: 0,
    provider_circuit_open: 0,
    latencies: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

let mem: ResilienceCounters = empty();

export function resetResilienceMetrics() {
  mem = empty();
}

export function markResilience(event: keyof Omit<ResilienceCounters, "latencies" | "startedAt" | "updatedAt">, n = 1) {
  mem[event] = (mem[event] || 0) + n;
  mem.updatedAt = new Date().toISOString();
}

export function markLatency(ms: number) {
  mem.latencies.push(ms);
  if (mem.latencies.length > 20_000) mem.latencies.splice(0, mem.latencies.length - 10_000);
  mem.updatedAt = new Date().toISOString();
}

function pct(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function resilienceSnapshot() {
  const lat = mem.latencies.slice().sort((a, b) => a - b);
  return {
    ...mem,
    success_rate: mem.request_total ? mem.success / mem.request_total : 1,
    failover_rate: mem.request_total ? mem.failover / mem.request_total : 0,
    retry_rate: mem.request_total ? mem.retry / mem.request_total : 0,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    p99: pct(lat, 99),
    latency_count: lat.length,
  };
}

export async function persistResilienceMetrics() {
  await mkdir(resolve("storage"), { recursive: true });
  const snap = resilienceSnapshot();
  const { latencies: _omit, ...rest } = mem;
  void _omit;
  await writeFile(FILE, JSON.stringify({ ...snap, latencies: mem.latencies.slice(-200) }, null, 2), "utf8");
  return rest;
}

export async function loadResilienceMetrics() {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as ResilienceCounters;
    mem = { ...empty(), ...raw, latencies: raw.latencies || [] };
  } catch {
    mem = empty();
  }
  return resilienceSnapshot();
}
