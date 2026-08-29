import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession } from "@/lib/saas-auth";
import { createRechargeOrder, tenantBillingSummary } from "@/lib/saas-billing";
import { uid } from "@/lib/utils";

export const Route = createFileRoute("/api/saas/billing")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertSaasSession(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        return Response.json(await tenantBillingSummary(auth.session.tenantId));
      },
      POST: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner", "admin", "billing"], { requireCsrf: true });
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        try {
          const result = await createRechargeOrder({
            tenantId: auth.session.tenantId,
            amountMinor: Number(body.amountMinor || 0),
            idempotencyKey: String(body.idempotencyKey || uid()),
            description: String(body.description || "Balance recharge"),
          });
          return Response.json({ ok: true, ...result }, { status: result.replay ? 200 : 201 });
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : "ORDER_CREATE_FAILED" }, { status: 400 });
        }
      },
    },
  },
});
