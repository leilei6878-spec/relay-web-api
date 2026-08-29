import { getSql, type Sql } from "./db";
import { settleTenantPlanPeriod } from "./saas-billing";
import { uid } from "./utils";

type DbLike = Pick<Sql, "query">;

export async function tickPlanRenewals(db?: DbLike) {
  const sql = db || await getSql();
  const tenants = await sql.query<{ id: string }>(
    `select t.id from relay_tenants t
      where t.status in ('trial','active') and (
        t.current_period_end<=now() or not exists (
          select 1 from relay_plan_periods p where p.tenant_id=t.id and p.period_start=t.current_period_start
        )
      ) order by t.current_period_end,t.id limit 100`,
  );
  const results: { tenantId: string; ok: boolean; error?: string }[] = [];
  for (const tenant of tenants) {
    try {
      await settleTenantPlanPeriod(tenant.id, sql);
      results.push({ tenantId: tenant.id, ok: true });
    } catch (error) {
      const code = (error instanceof Error ? error.message : "PLAN_RENEWAL_FAILED").slice(0, 120);
      results.push({ tenantId: tenant.id, ok: false, error: code });
      await sql.query(
        `insert into relay_commercial_audit(id,tenant_id,actor_type,actor_id,action,target_type,target_id,detail)
         select $1,$2,'system','plan-renewal','plan.period.failed','tenant',$2,$3::jsonb
          where not exists (select 1 from relay_commercial_audit where tenant_id=$2 and action='plan.period.failed' and created_at>now()-interval '24 hours')`,
        [uid(), tenant.id, JSON.stringify({ code })],
      );
    }
  }
  return results;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startPlanRenewalScheduler() {
  if (process.env.RELAY_TEST === "1" || process.env.RELAY_SKIP_PLAN_RENEWAL === "1") return false;
  if (timer) return true;
  const initial = setTimeout(() => void tickPlanRenewals().catch(() => undefined), 40_000);
  if (typeof initial === "object" && "unref" in initial) initial.unref();
  timer = setInterval(() => void tickPlanRenewals().catch(() => undefined), 60 * 60_000);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return true;
}
