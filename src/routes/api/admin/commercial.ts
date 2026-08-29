import { createFileRoute } from "@tanstack/react-router";
import { assertAdminMfa } from "@/lib/authz";
import { commercialAdminSnapshot, postBalanceAdjustment, publishPrice, scheduleTenantPlanChange, settleManualOrder, settleTenantPlanPeriod } from "@/lib/saas-billing";
import { getSql } from "@/lib/db";
import { createStripeRefund, reconcileStripeOrder } from "@/lib/payments";
import type { CommercialCapability } from "@/lib/commercial-types";
import { uid } from "@/lib/utils";

export const Route = createFileRoute("/api/admin/commercial")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdminMfa(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        return Response.json(await commercialAdminSnapshot());
      },
      POST: async ({ request }) => {
        const auth = await assertAdminMfa(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const action = String(body.action || "");
        try {
          let result: unknown;
          if (action === "settle-order") result = await settleManualOrder(String(body.orderId || ""), "admin");
          else if (action === "reconcile-payment") result = await reconcileStripeOrder(String(body.orderId || ""));
          else if (action === "refund-order") result = await createStripeRefund({
            orderId: String(body.orderId || ""), amountMinor: Number(body.amountMinor || 0),
            reason: String(body.reason || "Administrator refund"), idempotencyKey: String(body.idempotencyKey || uid()), actor: "admin",
          });
          else if (action === "adjust-balance") {
            result = await postBalanceAdjustment({
              tenantId: String(body.tenantId || ""), deltaMinor: Number(body.deltaMinor || 0),
              kind: "adjustment", idempotencyKey: String(body.idempotencyKey || uid()), description: String(body.description || "Administrator adjustment"),
            });
          } else if (action === "publish-price") {
            result = await publishPrice({
              provider: String(body.provider || ""), model: String(body.model || ""),
              capability: String(body.capability || "chat") as CommercialCapability,
              currency: String(body.currency || "USD"), inputMicrosPerMillion: Number(body.inputMicrosPerMillion || 0),
              outputMicrosPerMillion: Number(body.outputMicrosPerMillion || 0), imagePriceMinor: Number(body.imagePriceMinor || 0),
              markupBasisPoints: Number(body.markupBasisPoints || 0),
            });
          } else if (action === "tenant-status") {
            const sql = await getSql();
            const rows = await sql.query(
              "update relay_tenants set status=$2,updated_at=now() where id=$1 and $2 in ('trial','active','suspended','closed') returning id,status",
              [String(body.tenantId || ""), String(body.status || "")],
            );
            if (!rows[0]) throw new Error("TENANT_UPDATE_FAILED");
            result = rows[0];
          } else if (action === "tenant-plan") {
            result = await scheduleTenantPlanChange(String(body.tenantId || ""), String(body.planId || ""), "admin");
          } else if (action === "settle-plan-period") {
            result = await settleTenantPlanPeriod(String(body.tenantId || ""));
          } else if (action === "upsert-plan") {
            const sql = await getSql();
            const rows = await sql.query(
              `insert into relay_plans(id,name,status,currency,monthly_fee_minor,included_credit_minor,limits,features,created_at,updated_at)
               values ($1,$2,'active',$3,$4,$5,$6::jsonb,$7::jsonb,now(),now())
               on conflict(id) do update set name=excluded.name,status='active',currency=excluded.currency,
                 monthly_fee_minor=excluded.monthly_fee_minor,included_credit_minor=excluded.included_credit_minor,
                 limits=excluded.limits,features=excluded.features,updated_at=now()
               returning *`,
              [
                String(body.id || "").trim(), String(body.name || "").trim(), String(body.currency || "USD"),
                Math.max(0, Number(body.monthlyFeeMinor || 0)), Math.max(0, Number(body.includedCreditMinor || 0)),
                JSON.stringify(body.limits || {}), JSON.stringify(body.features || {}),
              ],
            );
            if (!rows[0]) throw new Error("PLAN_UPDATE_FAILED");
            result = rows[0];
          } else throw new Error("UNKNOWN_ACTION");
          const sql = await getSql();
          await sql.query(
            "insert into relay_commercial_audit(id,tenant_id,actor_type,actor_id,action,target_type,target_id,detail) values ($1,$2,'admin','admin',$3,$4,$5,$6::jsonb)",
            [uid(), body.tenantId || null, action, action.includes("price") ? "price" : action.includes("order") ? "order" : "tenant", body.orderId || body.tenantId || null, JSON.stringify({ fields: Object.keys(body).filter((key) => !["action"].includes(key)) })],
          );
          return Response.json({ ok: true, result });
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : "COMMERCIAL_ADMIN_FAILED" }, { status: 400 });
        }
      },
    },
  },
});
