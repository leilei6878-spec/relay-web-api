import { createHash } from "node:crypto";
import { assertPublicCommercialWebhookUrl, effectiveCommercialEnv } from "./commercial-config";
import { commercialEvidenceStatus } from "./commercial-evidence";
import { commercialReadiness } from "./commercial-readiness";
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
  const env = await effectiveCommercialEnv(process.env, sql);
  const canaryHours = Math.max(1, Math.min(168, Number(env.RELAY_PROVIDER_CANARY_MAX_AGE_HOURS || 24)));
  const [workers, reservations, failures, lowBalances, paymentEvents, refundSettlements, checkoutCreates, openDisputes, missingCanaries, duePlanPeriods, incompleteTenantAudits] = await Promise.all([
    sql.query<{ count: number }>("select count(*)::int as count from relay_workers where draining=false and last_beat > now()-interval '45 seconds'"),
    sql.query<{ count: number }>("select count(*)::int as count from relay_usage_charges where status='reserved' and created_at < now()-interval '20 minutes'"),
    sql.query<{ total: number; failed: number }>(
      "select count(*)::int as total,count(*) filter(where not ok)::int as failed from relay_usage where created_at > now()-interval '15 minutes'",
    ),
    sql.query<{ count: number }>(
      "select count(*)::int as count from relay_tenants where status in ('trial','active') and balance_minor-reserved_minor <= greatest(100,credit_limit_minor*-1)",
    ),
    sql.query<{ count: number }>(
      "select count(*)::int as count from relay_payment_events where status in ('received','failed') and created_at < now()-interval '5 minutes'",
    ),
    sql.query<{ count: number }>(
      "select count(*)::int as count from relay_payment_refunds where status='settlement_pending' and updated_at < now()-interval '5 minutes'",
    ),
    sql.query<{ count: number }>(
      "select count(*)::int as count from relay_orders where payment_provider='stripe' and status='creating' and created_at < now()-interval '10 minutes'",
    ),
    sql.query<{ count: number }>(
      "select count(*)::int as count from relay_payment_disputes where status in ('warning_needs_response','warning_under_review','needs_response','under_review')",
    ),
    sql.query<{ count: number }>(
      `select count(*)::int as count from relay_price_book p where p.status='active'
        and p.effective_from<=now() and (p.effective_to is null or p.effective_to>now())
        and not exists (select 1 from relay_provider_sandbox_runs r where r.provider=p.provider and r.model=p.model
          and r.capability=p.capability and r.currency=p.currency and r.mode='live'
          and r.status='passed' and r.finished_at>now()-($1::text||' hours')::interval)`,
      [canaryHours],
    ),
    sql.query<{ count: number }>(
      `select count(*)::int as count from relay_tenants t where t.status in ('trial','active') and (
        t.current_period_end<=now() or not exists (
          select 1 from relay_plan_periods p where p.tenant_id=t.id and p.period_start=t.current_period_start
        ))`,
    ),
    sql.query<{ count: number }>(
      `select count(*)::int as count from relay_tenant_audit_events s
        where s.outcome='started' and s.created_at < now()-interval '5 minutes'
          and not exists (
            select 1 from relay_tenant_audit_events terminal
             where terminal.operation_id=s.operation_id and terminal.outcome in ('succeeded','failed')
          )`,
    ),
  ]);
  const signals: CommercialSignal[] = [];
  if (Number(workers[0]?.count || 0) === 0) signals.push({ code: "WORKER_ZERO", severity: "critical", message: "No online worker is available" });
  if (Number(reservations[0]?.count || 0) > 0) signals.push({ code: "STALE_RESERVATION", severity: "critical", message: `${reservations[0]?.count} billing reservation(s) older than 20 minutes` });
  const total = Number(failures[0]?.total || 0);
  const failed = Number(failures[0]?.failed || 0);
  if (total >= 10 && failed / total >= 0.1) signals.push({ code: "FAILURE_RATE", severity: failed / total >= 0.25 ? "critical" : "warning", message: `15-minute failure rate ${Math.round(failed / total * 100)}%`, detail: { total, failed } });
  if (Number(lowBalances[0]?.count || 0) > 0) signals.push({ code: "LOW_TENANT_BALANCE", severity: "warning", message: `${lowBalances[0]?.count} tenant wallet(s) are low or exhausted` });
  if (Number(paymentEvents[0]?.count || 0) > 0) signals.push({ code: "PAYMENT_EVENT_STUCK", severity: "critical", message: `${paymentEvents[0]?.count} Stripe event(s) require reconciliation` });
  if (Number(refundSettlements[0]?.count || 0) > 0) signals.push({ code: "REFUND_SETTLEMENT_STUCK", severity: "critical", message: `${refundSettlements[0]?.count} refund(s) require ledger settlement` });
  if (Number(checkoutCreates[0]?.count || 0) > 0) signals.push({ code: "CHECKOUT_CREATE_STUCK", severity: "warning", message: `${checkoutCreates[0]?.count} Checkout order(s) are stuck during creation` });
  if (Number(openDisputes[0]?.count || 0) > 0) signals.push({ code: "PAYMENT_DISPUTE_OPEN", severity: "critical", message: `${openDisputes[0]?.count} Stripe dispute(s) require evidence or review` });
  if (Number(missingCanaries[0]?.count || 0) > 0) signals.push({ code: "PROVIDER_CANARY_MISSING", severity: "critical", message: `${missingCanaries[0]?.count} active commercial route(s) lack a live provider canary in the last ${canaryHours} hours` });
  const readiness = await commercialReadiness(env, sql);
  if (readiness.missingProviderCredentials.length > 0) signals.push({ code: "PROVIDER_CREDENTIAL_MISSING", severity: "critical", message: `Official credential missing for active provider(s): ${readiness.missingProviderCredentials.join(",")}` });
  if (Number(duePlanPeriods[0]?.count || 0) > 0) signals.push({ code: "PLAN_PERIOD_DUE", severity: env.RELAY_COMMERCIAL_ENABLED === "1" ? "critical" : "warning", message: `${duePlanPeriods[0]?.count} tenant plan period(s) require settlement` });
  if (Number(incompleteTenantAudits[0]?.count || 0) > 0) signals.push({
    code: "TENANT_AUDIT_INCOMPLETE",
    severity: "critical",
    message: `${incompleteTenantAudits[0]?.count} tenant mutation audit operation(s) have no terminal outcome`,
  });
  const missingEvidence = (await commercialEvidenceStatus(env, sql)).filter((item) => !item.valid);
  if (missingEvidence.length > 0) signals.push({
    code: "COMMERCIAL_LAUNCH_EVIDENCE_MISSING",
    severity: env.RELAY_COMMERCIAL_ENABLED === "1" ? "critical" : "warning",
    message: `${missingEvidence.length} commercial launch evidence requirement(s) are missing, failed, revoked or expired`,
    detail: { requirements: missingEvidence.slice(0, 25).map((item) => `${item.requirement}:${item.subject}:${item.reason}`) },
  });
  return signals;
}

async function deliverAlert(signal: CommercialSignal, db?: DbLike) {
  const env = await effectiveCommercialEnv(process.env, db);
  const url = env.RELAY_ALERT_WEBHOOK_URL?.trim();
  if (!url) return { delivered: false, reason: "not_configured" };
  await assertPublicCommercialWebhookUrl(url);
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
      await deliverAlert(signal, sql).catch(() => ({ delivered: false }));
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
