import { audit } from "./audit";
import { readControlPlane } from "./control-plane";
import { getSql } from "./db";
import { accountHealthReason, eligibilityReason, isLocked } from "./eligibility";
import type { Account, GatewaySettings, Platform, Proxy } from "./types";

type AvailabilityStats = {
  total: number;
  available: number;
  schedulable: number;
  busy: number;
  expiring24h: number;
  expiring7d: number;
  invalid: number;
  ipDrift: number;
};

export function summarizeAvailability(
  accounts: Account[],
  proxies: Proxy[],
  settings: GatewaySettings,
  now = Date.now(),
): AvailabilityStats {
  const available = accounts.filter((account) => !accountHealthReason(account, proxies, settings, now));
  const expiresWithin = (account: Account, ms: number) => {
    const at = Date.parse(account.expiresAt || "");
    return Number.isFinite(at) && at > now && at <= now + ms;
  };
  return {
    total: accounts.length,
    available: available.length,
    schedulable: accounts.filter((account) => !eligibilityReason(account, proxies, settings, now)).length,
    busy: accounts.filter((account) => isLocked(account, now)).length,
    expiring24h: accounts.filter((account) => expiresWithin(account, 86_400_000)).length,
    expiring7d: accounts.filter((account) => expiresWithin(account, 7 * 86_400_000)).length,
    invalid: accounts.filter((account) => account.status === "invalid" || account.status === "banned").length,
    ipDrift: accounts.filter((account) => account.ipState === "drift").length,
  };
}

function hourBucket(now: number) {
  const date = new Date(now);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

export async function captureAvailabilitySample(now = Date.now()) {
  const plane = await readControlPlane();
  const db = await getSql();
  const bucket = hourBucket(now);
  const platforms: (Platform | "all")[] = ["all", "chatgpt", "gemini", "leonardo"];
  for (const platform of platforms) {
    const accounts = platform === "all" ? plane.accounts : plane.accounts.filter((account) => account.platform === platform);
    const stats = summarizeAvailability(accounts, plane.proxies, plane.settings, now);
    await db.query(
      `insert into relay_account_availability_samples
        (bucket_at,platform,total,available,schedulable,busy,expiring_24h,expiring_7d,invalid,ip_drift,extra)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       on conflict (bucket_at,platform) do update set
         total=excluded.total, available=excluded.available, schedulable=excluded.schedulable,
         busy=excluded.busy, expiring_24h=excluded.expiring_24h, expiring_7d=excluded.expiring_7d,
         invalid=excluded.invalid, ip_drift=excluded.ip_drift, extra=excluded.extra`,
      [bucket, platform, stats.total, stats.available, stats.schedulable, stats.busy, stats.expiring24h, stats.expiring7d, stats.invalid, stats.ipDrift, JSON.stringify(stats)],
    );
  }

  const day = new Date(now).toISOString().slice(0, 10);
  for (const account of plane.accounts) {
    const reason = accountHealthReason(account, plane.proxies, plane.settings, now);
    const schedulableReason = eligibilityReason(account, plane.proxies, plane.settings, now);
    await db.query(
      `insert into relay_account_daily_snapshots
        (day,account_id,platform,status,available,schedulable,reason,observed_ip,expires_at,recorded_at,extra)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10::jsonb)
       on conflict (day,account_id) do update set
         platform=excluded.platform,status=excluded.status,available=excluded.available,
         schedulable=excluded.schedulable,reason=excluded.reason,observed_ip=excluded.observed_ip,
         expires_at=excluded.expires_at,recorded_at=now(),extra=excluded.extra`,
      [day, account.id, account.platform, account.status, !reason, !schedulableReason, reason || schedulableReason, account.lastProbeIp || null, account.expiresAt || null, JSON.stringify({ healthScore: account.healthScore ?? null })],
    );
  }
  return { ok: true as const, bucket, accounts: plane.accounts.length };
}

function dayOf(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export async function availabilityAnalytics(days = 30) {
  const boundedDays = Math.max(7, Math.min(90, Math.floor(days)));
  await captureAvailabilitySample();
  const db = await getSql();
  const since = new Date(Date.now() - (boundedDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const samples = await db.query<Record<string, unknown>>(
    `select * from relay_account_availability_samples
      where bucket_at >= $1::date
      order by bucket_at asc, platform asc`,
    [since],
  );
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of samples) {
    const key = `${dayOf(row.bucket_at)}:${row.platform}`;
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }

  const plane = await readControlPlane();
  const checks = await db.query<Record<string, unknown>>(
    `select account_id, platform, status, started_at
       from relay_account_checks
      where started_at >= $1::date
      order by account_id, started_at asc`,
    [since],
  );
  const recoveredByDay = new Map<string, Set<string>>();
  const failedAccounts = new Set<string>();
  for (const check of checks) {
    const id = String(check.account_id);
    if (check.status === "failed") failedAccounts.add(id);
    if (check.status === "passed" && failedAccounts.has(id)) {
      const key = `${dayOf(check.started_at)}:${check.platform}`;
      const set = recoveredByDay.get(key) || new Set<string>();
      set.add(id);
      recoveredByDay.set(key, set);
      failedAccounts.delete(id);
    }
  }

  const series = [...grouped.entries()].map(([key, rows]) => {
    const [day, platform] = key.split(":") as [string, Platform | "all"];
    const current = rows.at(-1)!;
    const available = rows.map((row) => Number(row.available || 0));
    const added = plane.accounts.filter((account) => dayOf(account.createdAt) === day && (platform === "all" || account.platform === platform)).length;
    const expired = plane.accounts.filter((account) => dayOf(account.expiresAt) === day && (platform === "all" || account.platform === platform)).length;
    const recovered = platform === "all"
      ? [...recoveredByDay.entries()].filter(([item]) => item.startsWith(`${day}:`)).reduce((sum, [, ids]) => sum + ids.size, 0)
      : recoveredByDay.get(`${day}:${platform}`)?.size || 0;
    return {
      day,
      platform,
      total: Number(current.total || 0),
      available: Number(current.available || 0),
      schedulable: Number(current.schedulable || 0),
      minimum: Math.min(...available),
      maximum: Math.max(...available),
      average: Math.round(available.reduce((sum, value) => sum + value, 0) / Math.max(1, available.length) * 10) / 10,
      added,
      expired,
      recovered,
      invalid: Number(current.invalid || 0),
      ipDrift: Number(current.ip_drift || 0),
    };
  });
  return { days: boundedDays, since, series, current: series.filter((row) => row.platform === "all").at(-1) || null };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAvailabilitySnapshotScheduler() {
  if (process.env.RELAY_TEST === "1" || process.env.RELAY_SKIP_ACCOUNT_ANALYTICS === "1" || process.env.RELAY_EXTERNAL_SCHEDULER === "1") return false;
  if (timer) return true;
  const initial = setTimeout(() => void captureAvailabilitySample().catch(() => undefined), 20_000);
  if (typeof initial === "object" && "unref" in initial) initial.unref();
  timer = setInterval(() => void captureAvailabilitySample().catch(() => undefined), 60 * 60_000);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  void audit("account.analytics.start", "hourly availability snapshots enabled").catch(() => undefined);
  return true;
}
