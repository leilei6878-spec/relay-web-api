import { createAccountCheckRun } from "./account-checks";
import { readControlPlane } from "./control-plane";
import { coordSetNx } from "./coord";

const STATIC_MS = 15 * 60_000;
const PROXY_MS = 30 * 60_000;
const LIVE_MS = 2 * 60 * 60_000;

function due(last: string | null | undefined, interval: number, now: number) {
  const at = Date.parse(last || "");
  return !Number.isFinite(at) || now - at >= interval;
}

export function dueAccountCheckLevels(
  account: {
    lastStaticProbeAt?: string | null;
    lastProxyProbeAt?: string | null;
    lastLiveProbeAt?: string | null;
    expiresAt?: string | null;
  },
  now = Date.now(),
) {
  const nearExpiry = account.expiresAt && Date.parse(account.expiresAt) > now && Date.parse(account.expiresAt) <= now + 86_400_000;
  const levels: ("static" | "proxy" | "live")[] = [];
  if (due(account.lastStaticProbeAt, nearExpiry ? 30 * 60_000 : STATIC_MS, now)) levels.push("static");
  if (due(account.lastProxyProbeAt, PROXY_MS, now)) levels.push("proxy");
  if (due(account.lastLiveProbeAt, nearExpiry ? 30 * 60_000 : LIVE_MS, now)) levels.push("live");
  return levels;
}

export async function tickAccountCheckScheduler(now = Date.now()) {
  const slot = Math.floor(now / 60_000);
  if (!(await coordSetNx(`account-check-scheduler:${slot}`, "1", 120_000))) return { dispatched: 0, claimed: false };
  const plane = await readControlPlane();
  const due = plane.accounts.filter((account) => account.autoCheck !== false && dueAccountCheckLevels(account, now).length > 0).slice(0, 20);
  let dispatched = 0;
  const groups = new Map<string, string[]>();
  for (const account of due) {
    const key = dueAccountCheckLevels(account, now).join(",");
    groups.set(key, [...(groups.get(key) || []), account.id]);
  }
  for (const [key, ids] of groups) {
    const result = await createAccountCheckRun({
      trigger: "scheduled",
      requestedBy: "scheduler",
      scope: { ids },
      levels: key.split(","),
    });
    if (result.ok) dispatched += ids.length;
  }
  return { dispatched, claimed: true };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAccountCheckScheduler() {
  if (process.env.RELAY_TEST === "1" || process.env.RELAY_SKIP_ACCOUNT_CHECK_SCHEDULER === "1") return false;
  if (timer) return true;
  const initial = setTimeout(() => void tickAccountCheckScheduler().catch(() => undefined), 15_000);
  if (typeof initial === "object" && "unref" in initial) initial.unref();
  timer = setInterval(() => void tickAccountCheckScheduler().catch(() => undefined), 60_000);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return true;
}

export function stopAccountCheckScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
