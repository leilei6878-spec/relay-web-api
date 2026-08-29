import { createHash } from "node:crypto";
import { coordSetNx } from "./coord";
import { getSql, type Sql } from "./db";
import { uid } from "./utils";

export type CommercialSignal = {
  code: string;
  severity: "warning" | "critical";
  message: string;
  detail?: Record<string, unknown>;
};

function fingerprint(signal: CommercialSignal) {
  return createHash("sha256").update(`${signal.code}:${signal.message}`).digest("hex").slice(0, 32);
}

type DbLike = Pick<Sql, "query">;

export async function collectCommercialSignals(db?: DbLike) {
  const sql = db || await getSql();
  const [workers, reservations, failures, lowBalances] = await Promise.all([
    sql.query<{ count: number }>("select count(*)::int as count from relay_workers where draining=false and last_beat > now()-interval '45 seconds'"),
    sql.query<{ count: number }>("select count(*)::int as count from relay_usage_charges where status='reserved' and created_at < now()-interval '20 minutes'"),
    sql.query<{ total: number; failed: number }>(
      "select count(*)::int as total,count(*) filter(where not ok)::int as failed from relay_usage where created_at > now()-interval '15 minutes'",
    ),
    sql.query<{ count: number }>(
      "select count(*)::int as count from relay_tenants where status in ('trial','active') and balance_minor-reserved_minor <= greatest(100,credit_limit_minor*-1)",
    ),
  ]);
  const signals: CommercialSignal[] = [];
  if (Number(workers[0]?.count || 0) === 0) signals.push({ code: "WORKER_ZERO", severity: "critical", message: "No online worker is available" });
  if (Number(reservations[0]?.count || 0) > 0) signals.push({ code: "STALE_RESERVATION", severity: "critical", message: `${reservations[0]?.count} billing reservation(s) older than 20 minutes` });
  const total = Number(failures[0]?.total || 0);
  const failed = Number(failures[0]?.failed || 0);
  if (total >= 10 && failed / total >= 0.1) signals.push({ code: "FAILURE_RATE", severity: failed / total >= 0.25 ? "critical" : "warning", message: `15-minute failure rate ${Math.round(failed / total * 100)}%`, detail: { total, failed } });
  if (Number(lowBalances[0]?.count || 0) > 0) signals.push({ code: "LOW_TENANT_BALANCE", severity: "warning", message: `${lowBalances[0]?.count} tenant wallet(s) are low or exhausted` });
  return signals;
}

async function deliverAlert(signal: CommercialSignal) {
  const url = process.env.RELAY_ALERT_WEBHOOK_URL?.trim();
  if (!url) return { delivered: false, reason: "not_configured" };
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ source: "relay-saas", ...signal, at: new Date().toISOString() }),
  });
  return { delivered: response.ok, status: response.status };
}

export async function persistCommercialSignals(signals: CommercialSignal[], db?: DbLike) {
  const sql = db || await getSql();
  const active = new Set(signals.map(fingerprint));
  for (const signal of signals) {
    const fp = fingerprint(signal);
    const rows = await sql.query<{ id: string; created: boolean }>(
      `insert into relay_alert_events(id,code,severity,status,message,fingerprint,first_seen_at,last_seen_at,occurrences,extra)
       values ($1,$2,$3,'open',$4,$5,now(),now(),1,$6::jsonb)
       on conflict (fingerprint) where status='open' do update set
         severity=excluded.severity,message=excluded.message,last_seen_at=now(),occurrences=relay_alert_events.occurrences+1,extra=excluded.extra
       returning id,(xmax=0) as created`,
      [uid(), signal.code, signal.severity, signal.message, fp, JSON.stringify(signal.detail || {})],
    );
    const id = rows[0]?.id;
    if (id && rows[0]?.created && await coordSetNx(`alert:deliver:${fp}`, "1", 15 * 60_000)) {
      await deliverAlert(signal).catch(() => ({ delivered: false }));
    }
  }
  const open = await sql.query<{ id: string; fingerprint: string }>("select id,fingerprint from relay_alert_events where status='open'");
  for (const row of open) {
    if (!active.has(row.fingerprint)) {
      await sql.query("update relay_alert_events set status='resolved',resolved_at=now(),last_seen_at=now() where id=$1 and status='open'", [row.id]);
    }
  }
}

export async function tickCommercialMonitor() {
  const signals = await collectCommercialSignals();
  await persistCommercialSignals(signals);
  return signals;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startCommercialMonitor() {
  if (process.env.RELAY_TEST === "1" || process.env.RELAY_SKIP_COMMERCIAL_MONITOR === "1") return false;
  if (timer) return true;
  const initial = setTimeout(() => void tickCommercialMonitor().catch(() => undefined), 25_000);
  if (typeof initial === "object" && "unref" in initial) initial.unref();
  timer = setInterval(() => void tickCommercialMonitor().catch(() => undefined), 60_000);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return true;
}
