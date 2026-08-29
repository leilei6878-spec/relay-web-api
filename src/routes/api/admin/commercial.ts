import { createFileRoute } from "@tanstack/react-router";
import { assertAdmin } from "@/lib/authz";
import { commercialAdminSnapshot, postBalanceAdjustment, publishPrice, settleManualOrder } from "@/lib/saas-billing";
import { getSql } from "@/lib/db";
import type { CommercialCapability } from "@/lib/commercial-types";
import { uid } from "@/lib/utils";

export const Route = createFileRoute("/api/admin/commercial")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        return Response.json(await commercialAdminSnapshot());
      },
      POST: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const action = String(body.action || "");
        try {
          let result: unknown;
          if (action === "settle-order") result = await settleManualOrder(String(body.orderId || ""), "admin");
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
