import { getSql } from "./db";
import { effectiveCommercialEnv } from "./commercial-config";

function boundedDays(raw: string | undefined, fallback: number, min: number, max: number) {
  const value = Number(raw || fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

export function retentionPolicy(env: NodeJS.ProcessEnv = process.env) {
  return {
    requestContentDays: boundedDays(env.RELAY_REQUEST_CONTENT_RETENTION_DAYS, 30, 1, 365),
    sessionDays: boundedDays(env.RELAY_SESSION_RETENTION_DAYS, 30, 1, 365),
    operationalDays: boundedDays(env.RELAY_OPERATIONAL_RETENTION_DAYS, 90, 7, 730),
    auditDays: boundedDays(env.RELAY_AUDIT_RETENTION_DAYS, 365, 90, 2555),
    billingYears: 7,
  };
}

export async function runDataRetention(env: NodeJS.ProcessEnv = process.env) {
  if (env === process.env) env = await effectiveCommercialEnv(env);
  const policy = retentionPolicy(env);
  const sql = await getSql();
  const [chargeResults, jobs, sessions, checks, usage, checkoutUrls, audit] = await Promise.all([
    sql.query<{ count: number }>(
      `with updated as (
         update relay_usage_charges set extra=extra-'providerResultCiphertext'
          where created_at < now()-($1::text||' days')::interval and extra ? 'providerResultCiphertext'
          returning id
       ) select count(*)::int as count from updated`,
      [policy.requestContentDays],
    ),
    sql.query<{ count: number }>(
      `with updated as (
         update relay_jobs set prompt='[REDACTED]',text=null,url=null,images='[]'::jsonb,
           extra=(coalesce(extra,'{}'::jsonb)-'prompt'-'text'-'url'-'urls'-'images'-'turns'-'accountEmail')
          where created_at < now()-($1::text||' days')::interval and prompt <> '[REDACTED]'
          returning id
       ) select count(*)::int as count from updated`,
      [policy.requestContentDays],
    ),
    sql.query<{ count: number }>(
      `with deleted as (
         delete from relay_saas_sessions
          where (revoked_at is not null or expires_at < now())
            and coalesce(revoked_at,expires_at) < now()-($1::text||' days')::interval
          returning id
       ) select count(*)::int as count from deleted`,
      [policy.sessionDays],
    ),
    sql.query<{ count: number }>(
      `with deleted as (
         delete from relay_account_checks where started_at < now()-($1::text||' days')::interval returning id
       ) select count(*)::int as count from deleted`,
      [policy.operationalDays],
    ),
    sql.query<{ count: number }>(
      `with updated as (
         update relay_usage set extra=(coalesce(extra,'{}'::jsonb)-'promptPreview'-'accountEmail')
          where created_at < now()-($1::text||' days')::interval
            and (extra ? 'promptPreview' or extra ? 'accountEmail') returning id
       ) select count(*)::int as count from updated`,
      [policy.requestContentDays],
    ),
    sql.query<{ count: number }>(
      `with updated as (
         update relay_orders set checkout_url=null,updated_at=now()
          where checkout_url is not null and coalesce(checkout_expires_at,expires_at,created_at) < now()
          returning id
       ) select count(*)::int as count from updated`,
    ),
    sql.query<{ count: number }>(
      `with deleted as (
         delete from relay_commercial_audit where created_at < now()-($1::text||' days')::interval returning id
       ) select count(*)::int as count from deleted`,
      [policy.auditDays],
    ),
  ]);
  // Billing transactions/entries are intentionally never deleted here. Object
  // media must use the configured S3 bucket lifecycle because deleting rows
  // without an authoritative object deletion would create hidden retained data.
  return {
    policy,
    redactedJobs: Number(jobs[0]?.count || 0),
    deletedSessions: Number(sessions[0]?.count || 0),
    deletedChecks: Number(checks[0]?.count || 0),
    redactedUsage: Number(usage[0]?.count || 0),
    redactedChargeResults: Number(chargeResults[0]?.count || 0),
    redactedCheckoutUrls: Number(checkoutUrls[0]?.count || 0),
    deletedAudit: Number(audit[0]?.count || 0),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDataRetentionScheduler() {
  if (process.env.RELAY_TEST === "1" || process.env.RELAY_SKIP_RETENTION === "1") return false;
  if (timer) return true;
  const initial = setTimeout(() => void runDataRetention().catch(() => undefined), 90_000);
  if (typeof initial === "object" && "unref" in initial) initial.unref();
  timer = setInterval(() => void runDataRetention().catch(() => undefined), 24 * 60 * 60_000);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return true;
}
