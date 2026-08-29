import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession } from "@/lib/saas-auth";
import { createRechargeOrder, scheduleTenantPlanChange, tenantBillingSummary } from "@/lib/saas-billing";
import { createStripeCheckout } from "@/lib/payments";
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
          const action = String(body.action || "checkout");
          if (action === "change-plan") {
            const result = await scheduleTenantPlanChange(auth.session.tenantId, String(body.planId || ""), `user:${auth.session.userId}`);
            return Response.json({ ok: true, result });
          }
          if (action === "checkout") {
            const result = await createStripeCheckout({
              tenantId: auth.session.tenantId,
              amountMinor: Number(body.amountMinor || 0),
              idempotencyKey: String(body.idempotencyKey || uid()),
            });
            return Response.json({ ok: true, ...result }, { status: result.replay ? 200 : 201 });
          }
          if (action !== "manual" || process.env.RELAY_ALLOW_MANUAL_CUSTOMER_ORDERS !== "1") {
            throw new Error("PAYMENT_ACTION_NOT_AVAILABLE");
          }
          const result = await createRechargeOrder({
            tenantId: auth.session.tenantId,
            amountMinor: Number(body.amountMinor || 0),
            idempotencyKey: String(body.idempotencyKey || uid()),
            description: String(body.description || "Balance recharge"),
          });
          return Response.json({ ok: true, ...result }, { status: result.replay ? 200 : 201 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "ORDER_CREATE_FAILED";
          const status = message.startsWith("STRIPE_API_ERROR") ? 502
            : /^(COMMERCIAL_|PAYMENT_PROVIDER_|STRIPE_.*_MISSING|STRIPE_LIVE_KEY_REQUIRED)/.test(message) ? 503
              : 400;
          return Response.json({ ok: false, error: message }, { status });
        }
      },
    },
  },
});
