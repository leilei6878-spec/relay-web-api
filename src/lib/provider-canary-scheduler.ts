import { enqueueProviderCanary } from "./provider/canary-run";
import type { ProviderId } from "./circuit";

export type CanaryKind = "structural" | "paid";

const PROVIDERS: ProviderId[] = ["chatgpt", "gemini", "leonardo"];

export function parseInterval(raw?: string | null): number {
  const s = String(raw || "").trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const u = (m[2] || "ms").toLowerCase();
  if (u === "ms") return n;
  if (u === "s") return n * 1000;
  if (u === "m") return n * 60_000;
  if (u === "h") return n * 3_600_000;
  if (u === "d") return n * 86_400_000;
  return n;
}

export function structuralCanaryMs() {
  return parseInterval(process.env.RELAY_STRUCTURAL_CANARY_INTERVAL) || 7 * 60_000;
}

export function realImageCanaryMs() {
  return parseInterval(process.env.REAL_IMAGE_CANARY_INTERVAL) || 3 * 3_600_000;
}

export function nextCanaryDelay(baseMs: number, jitterRatio = 0.2, rand = Math.random()) {
  const base = Math.max(60_000, baseMs);
  const j = base * Math.min(0.5, Math.max(0, jitterRatio));
  return Math.round(base - j + rand * 2 * j);
}

export function isPaidImageCanary(provider: ProviderId, kind: CanaryKind) {
  return kind === "paid" && (provider === "gemini" || provider === "leonardo");
}

type Due = { provider: ProviderId; kind: CanaryKind; at: number };

const nextDue: Due[] = [];

export function resetCanarySchedulerForTests() {
  nextDue.length = 0;
}

export function scheduleCanaries(now = Date.now()) {
  nextDue.length = 0;
  const structural = nextCanaryDelay(structuralCanaryMs(), 0.2, 0.5);
  const paid = nextCanaryDelay(realImageCanaryMs(), 0.2, 0.5);
  for (const provider of PROVIDERS) {
    nextDue.push({ provider, kind: "structural", at: now + structural });
    if (provider !== "chatgpt") nextDue.push({ provider, kind: "paid", at: now + paid });
  }
  return nextDue.slice();
}

export function dueCanaries(now = Date.now()) {
  if (!nextDue.length) scheduleCanaries(now);
  return nextDue.filter((d) => d.at <= now);
}

export async function tickProviderCanaries(now = Date.now()) {
  const due = dueCanaries(now);
  const ran: { provider: ProviderId; kind: CanaryKind; ok: boolean; error?: string }[] = [];
  for (const item of due) {
    item.at = now + nextCanaryDelay(item.kind === "paid" ? realImageCanaryMs() : structuralCanaryMs(), 0.2);
    if (item.kind === "paid") {
      ran.push({ provider: item.provider, kind: "paid", ok: true, error: "skipped: paid interval only, no structural generation" });
      continue;
    }
    const out = await enqueueProviderCanary(item.provider);
    ran.push({ provider: item.provider, kind: item.kind, ok: out.ok, error: out.ok ? undefined : out.error });
  }
  return ran;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startProviderCanaryScheduler() {
  if (process.env.RELAY_TEST === "1" || process.env.RELAY_SKIP_CANARY_SCHEDULER === "1") return false;
  if (timer) return true;
  scheduleCanaries();
  timer = setInterval(() => {
    tickProviderCanaries().catch(() => undefined);
  }, 30_000);
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  return true;
}

export function stopProviderCanaryScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
