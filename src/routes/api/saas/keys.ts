import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession } from "@/lib/saas-auth";
import { createTenantApiKey, listTenantApiKeys, revokeTenantApiKey } from "@/lib/saas-api-keys";
import type { CommercialCapability } from "@/lib/commercial-types";

export const Route = createFileRoute("/api/saas/keys")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertSaasSession(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        return Response.json({ keys: await listTenantApiKeys(auth.session.tenantId) });
      },
      POST: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner", "admin", "developer"], { requireCsrf: true, requireMfa: true });
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        try {
          const key = await createTenantApiKey({
            tenantId: auth.session.tenantId,
            createdBy: auth.session.userId,
            name: String(body.name || "Production"),
            scopes: (Array.isArray(body.scopes) ? body.scopes : ["chat", "image"]) as CommercialCapability[],
            modelAllowlist: Array.isArray(body.modelAllowlist) ? body.modelAllowlist.map(String) : [],
            requestsPerMinute: Number(body.requestsPerMinute || 0),
            concurrencyLimit: Number(body.concurrencyLimit || 0),
            dailyRequestLimit: Number(body.dailyRequestLimit || 0),
            monthlySpendLimitMinor: Number(body.monthlySpendLimitMinor || 0),
            expiresAt: body.expiresAt ? String(body.expiresAt) : null,
          });
          return Response.json({ ok: true, key: { id: key.id, hint: key.hint }, secret: key.token }, { status: 201 });
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : "KEY_CREATE_FAILED" }, { status: 400 });
        }
      },
      DELETE: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner", "admin", "developer"], { requireCsrf: true, requireMfa: true });
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as { id?: string };
        const ok = await revokeTenantApiKey(auth.session.tenantId, body.id || "");
        return Response.json({ ok }, { status: ok ? 200 : 404 });
      },
    },
  },
});
