import { createHash, createHmac } from "node:crypto";
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

const alertSensitiveKey = /token|secret|password|cookie|authorization|api.?key|credential|email|ip.?address|user.?agent/i;
const alertSensitiveValue = /(?:\bsk-[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9_-]+|\bBearer\s+[A-Za-z0-9._-]{12,}|\b[^\s@]+@[^\s@]+\.[^\s@]+\b)/i;

function cleanAlertDetail(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return alertSensitiveValue.test(value) ? "[REDACTED]" : value.slice(0, 200);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => cleanAlertDetail(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !alertSensitiveKey.test(key)).slice(0, 30)
      .map(([key, item]) => [key.slice(0, 80), cleanAlertDetail(item, depth + 1)]));
  }
  return null;
}

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

export type AlertDeliveryResult = {
  delivered: boolean;
  configured: boolean;
  status?: number;
  errorCode?: string;
};

type AlertDeliveryRow = Record<string, unknown> & {
  id: string;
  alert_id: string;
  event_type: "opened" | "resolved";
  attempts: number;
  payload: Record<string, unknown>;
};

type Resolver = Parameters<typeof assertPublicCommercialWebhookUrl>[1];

export async function sendAlertWebhook(
  deliveryId: string,
  payload: Record<string, unknown>,
  opts: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; resolver?: Resolver; now?: Date } = {},
): Promise<AlertDeliveryResult> {
  const env = opts.env || process.env;
  const url = env.RELAY_ALERT_WEBHOOK_URL?.trim() || "";
  if (!url) return { delivered: false, configured: false, errorCode: "ALERT_WEBHOOK_NOT_CONFIGURED" };
  const secret = env.RELAY_ALERT_WEBHOOK_SECRET?.trim() || "";
  if (secret.length < 32) return { delivered: false, configured: false, errorCode: "ALERT_WEBHOOK_SECRET_INVALID" };
  let endpoint: string;
  try {
    endpoint = await assertPublicCommercialWebhookUrl(url, opts.resolver);
  } catch {
    return { delivered: false, configured: false, errorCode: "ALERT_WEBHOOK_URL_INVALID" };
  }
  const body = JSON.stringify(payload);
  const timestamp = Math.floor((opts.now || new Date()).getTime() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  try {
    const response = await (opts.fetcher || fetch)(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Event-Id": deliveryId,
        "X-Relay-Timestamp": timestamp,
        "X-Relay-Signature": `v1=${signature}`,
      },
      signal: AbortSignal.timeout(10_000),
      body,
    });
    return response.ok
      ? { delivered: true, configured: true, status: response.status }
      : { delivered: false, configured: true, status: response.status, errorCode: "ALERT_WEBHOOK_HTTP_ERROR" };
  } catch {
    return { delivered: false, configured: true, errorCode: "ALERT_WEBHOOK_NETWORK_ERROR" };
  }
}

function alertDeliveryPayload(alert: Record<string, unknown>, eventType: "opened" | "resolved", deliveryId: string) {
  const detail = alert.extra && typeof alert.extra === "object" ? alert.extra : {};
  let payload: Record<string, unknown> = {
    source: "relay-saas",
    deliveryId,
    alertId: String(alert.id),
    event: eventType,
    code: String(alert.code),
    severity: String(alert.severity),
    status: eventType === "resolved" ? "resolved" : "open",
    message: String(alert.message).slice(0, 500),
    occurrences: Number(alert.occurrences || 1),
    firstSeenAt: alert.first_seen_at,
    lastSeenAt: alert.last_seen_at,
    resolvedAt: eventType === "resolved" ? alert.resolved_at : null,
    detail,
  };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 15_000) payload = { ...payload, detail: { truncated: true } };
  return payload;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => [key, canonicalJson(item)]));
  }
  return value;
}

function alertPayloadDigest(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalJson(payload))).digest("hex");
}

async function enqueueAlertDelivery(alert: Record<string, unknown>, eventType: "opened" | "resolved", sql: DbLike) {
  const id = uid();
  const payload = alertDeliveryPayload(alert, eventType, id);
  const serialized = JSON.stringify(payload);
  await sql.query(
    `insert into relay_alert_deliveries
      (id,alert_id,event_type,status,attempts,payload,payload_sha256,next_attempt_at,created_at,updated_at)
     values ($1,$2,$3,'pending',0,$4::jsonb,$5,now(),now(),now())
     on conflict (alert_id,event_type) do nothing`,
    [id, alert.id, eventType, serialized, alertPayloadDigest(payload)],
  );
}

function retryDelaySeconds(attempt: number) {
  return Math.min(3600, 60 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
}

export async function deliverDueAlertNotifications(
  db?: DbLike,
  opts: {
    deliver?: (delivery: AlertDeliveryRow) => Promise<AlertDeliveryResult>;
    acquireLock?: (id: string) => Promise<boolean>;
    limit?: number;
  } = {},
) {
  const sql = db || await getSql();
  await sql.query(
    `update relay_alert_deliveries set status='retrying',claim_expires_at=null,next_attempt_at=now(),
       error_code='ALERT_DELIVERY_CLAIM_EXPIRED',updated_at=now()
      where status='sending' and claim_expires_at < now()`,
  );
  const due = await sql.query<AlertDeliveryRow>(
    `select * from relay_alert_deliveries
      where status in ('pending','retrying','not_configured') and next_attempt_at<=now()
      order by next_attempt_at,created_at limit $1`,
    [Math.max(1, Math.min(100, Math.floor(opts.limit || 25)))],
  );
  const env = opts.deliver ? null : await effectiveCommercialEnv(process.env, sql);
  const deliver = opts.deliver || ((delivery: AlertDeliveryRow) => sendAlertWebhook(delivery.id, delivery.payload, { env: env! }));
  const acquireLock = opts.acquireLock || ((id: string) => coordSetNx(`alert:delivery:${id}`, "1", 2 * 60_000).catch(() => true));
  let delivered = 0;
  let failed = 0;
  for (const row of due) {
    if (!await acquireLock(row.id)) continue;
    const claimed = await sql.query<AlertDeliveryRow>(
      `update relay_alert_deliveries set status='sending',claim_expires_at=now()+interval '2 minutes',updated_at=now()
        where id=$1 and status in ('pending','retrying','not_configured') and next_attempt_at<=now() returning *`,
      [row.id],
    );
    const delivery = claimed[0];
    if (!delivery) continue;
    if (alertPayloadDigest(delivery.payload) !== String(delivery.payload_sha256)) {
      await sql.query(
        `update relay_alert_deliveries set status='retrying',claim_expires_at=null,
           next_attempt_at=now()+interval '1 hour',error_code='ALERT_DELIVERY_PAYLOAD_HASH_MISMATCH',updated_at=now()
          where id=$1 and status='sending'`,
        [delivery.id],
      );
      failed += 1;
      continue;
    }
    const result = await deliver(delivery).catch(() => ({
      delivered: false, configured: true, errorCode: "ALERT_WEBHOOK_DELIVERY_ERROR",
    } as AlertDeliveryResult));
    if (!result.configured) {
      await sql.query(
        `update relay_alert_deliveries set status='not_configured',claim_expires_at=null,
           next_attempt_at=now()+interval '5 minutes',http_status=null,error_code=$2,updated_at=now()
          where id=$1 and status='sending'`,
        [delivery.id, result.errorCode || "ALERT_WEBHOOK_NOT_CONFIGURED"],
      );
      continue;
    }
    const attempt = Number(delivery.attempts || 0) + 1;
    if (result.delivered) {
      await sql.query(
        `update relay_alert_deliveries set status='delivered',attempts=$2,last_attempt_at=now(),
           delivered_at=now(),claim_expires_at=null,http_status=$3,error_code=null,updated_at=now()
          where id=$1 and status='sending'`,
        [delivery.id, attempt, result.status || 200],
      );
      delivered += 1;
      if (delivery.event_type === "opened") {
        const alerts = await sql.query<Record<string, unknown>>("select * from relay_alert_events where id=$1", [delivery.alert_id]);
        if (alerts[0]?.status === "resolved") await enqueueAlertDelivery(alerts[0], "resolved", sql);
      }
      continue;
    }
    const alerts = await sql.query<{ status: string }>("select status from relay_alert_events where id=$1", [delivery.alert_id]);
    if (delivery.event_type === "opened" && alerts[0]?.status === "resolved") {
      await sql.query(
        `update relay_alert_deliveries set status='superseded',attempts=$2,last_attempt_at=now(),
           claim_expires_at=null,http_status=$3,error_code=$4,updated_at=now()
          where id=$1 and status='sending'`,
        [delivery.id, attempt, result.status || null, result.errorCode || "ALERT_WEBHOOK_DELIVERY_FAILED"],
      );
    } else {
      await sql.query(
        `update relay_alert_deliveries set status='retrying',attempts=$2,last_attempt_at=now(),
           claim_expires_at=null,next_attempt_at=now()+($3::text||' seconds')::interval,
           http_status=$4,error_code=$5,updated_at=now()
          where id=$1 and status='sending'`,
        [delivery.id, attempt, retryDelaySeconds(attempt), result.status || null, result.errorCode || "ALERT_WEBHOOK_DELIVERY_FAILED"],
      );
    }
    failed += 1;
  }
  return { scanned: due.length, delivered, failed };
}

export async function retryAlertDeliveriesNow(
  db?: DbLike,
  opts: Parameters<typeof deliverDueAlertNotifications>[1] = {},
) {
  const sql = db || await getSql();
  await sql.query(
    `update relay_alert_deliveries set next_attempt_at=now(),updated_at=now()
      where status in ('pending','retrying','not_configured')`,
  );
  return deliverDueAlertNotifications(sql, opts);
}

export async function persistCommercialSignals(
  signals: CommercialSignal[],
  db?: DbLike,
  deliveryOptions: Parameters<typeof deliverDueAlertNotifications>[1] = {},
) {
  const sql = db || await getSql();
  const active = new Set(signals.map(fingerprint));
  for (const signal of signals) {
    const fp = fingerprint(signal);
    const rows = await sql.query<Record<string, unknown>>(
      `insert into relay_alert_events(id,code,severity,status,message,fingerprint,first_seen_at,last_seen_at,occurrences,extra)
       values ($1,$2,$3,'open',$4,$5,now(),now(),1,$6::jsonb)
       on conflict (fingerprint) where status='open' do update set
         severity=excluded.severity,message=excluded.message,last_seen_at=now(),occurrences=relay_alert_events.occurrences+1,extra=excluded.extra
       returning *`,
      [uid(), signal.code.slice(0, 120), signal.severity, signal.message.slice(0, 500), fp, JSON.stringify(cleanAlertDetail(signal.detail || {}))],
    );
    if (rows[0]) await enqueueAlertDelivery(rows[0], "opened", sql);
  }
  const open = await sql.query<Record<string, unknown>>("select * from relay_alert_events where status='open'");
  for (const row of open) {
    if (!active.has(String(row.fingerprint))) {
      const resolved = await sql.query<Record<string, unknown>>(
        "update relay_alert_events set status='resolved',resolved_at=now(),last_seen_at=now() where id=$1 and status='open' returning *",
        [row.id],
      );
      if (!resolved[0]) continue;
      const opened = await sql.query<{ status: string }>(
        "select status from relay_alert_deliveries where alert_id=$1 and event_type='opened'",
        [row.id],
      );
      if (opened[0]?.status === "delivered") await enqueueAlertDelivery(resolved[0], "resolved", sql);
      else if (opened[0] && opened[0].status !== "sending") {
        await sql.query(
          "update relay_alert_deliveries set status='superseded',claim_expires_at=null,updated_at=now() where alert_id=$1 and event_type='opened' and status<>'delivered'",
          [row.id],
        );
      }
    }
  }
  return deliverDueAlertNotifications(sql, deliveryOptions);
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
