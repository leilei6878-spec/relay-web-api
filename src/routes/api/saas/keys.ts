import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession } from "@/lib/saas-auth";
import { createTenantApiKey, listTenantApiKeys, revokeTenantApiKey } from "@/lib/saas-api-keys";
import { auditedTenantMutation } from "@/lib/tenant-audit";
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
          const scopes = (Array.isArray(body.scopes) ? body.scopes : ["chat", "image"]) as CommercialCapability[];
          const modelAllowlist = Array.isArray(body.modelAllowlist) ? body.modelAllowlist.map(String) : [];
          const key = await auditedTenantMutation(request, auth.session, {
            action: "api_key.create",
            targetType: "api_key",
            detail: { scopes, modelAllowlistCount: modelAllowlist.length, expires: Boolean(body.expiresAt) },
            resultTargetId: (result) => result.id,
          }, () => createTenantApiKey({
              tenantId: auth.session.tenantId,
              createdBy: auth.session.userId,
              name: String(body.name || "Production"),
              scopes,
              modelAllowlist,
              requestsPerMinute: Number(body.requestsPerMinute || 0),
              concurrencyLimit: Number(body.concurrencyLimit || 0),
              dailyRequestLimit: Number(body.dailyRequestLimit || 0),
              monthlySpendLimitMinor: Number(body.monthlySpendLimitMinor || 0),
              expiresAt: body.expiresAt ? String(body.expiresAt) : null,
            }));
          return Response.json({ ok: true, key: { id: key.id, hint: key.hint }, secret: key.token }, { status: 201 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "KEY_CREATE_FAILED";
          return Response.json({ ok: false, error: message }, { status: message === "TENANT_AUDIT_UNAVAILABLE" ? 503 : 400 });
        }
      },
      DELETE: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner", "admin", "developer"], { requireCsrf: true, requireMfa: true });
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as { id?: string };
        try {
          const ok = await auditedTenantMutation(request, auth.session, {
            action: "api_key.revoke", targetType: "api_key", targetId: body.id || null,
          }, () => revokeTenantApiKey(auth.session.tenantId, body.id || ""));
          return Response.json({ ok }, { status: ok ? 200 : 404 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "KEY_REVOKE_FAILED";
          return Response.json({ ok: false, error: message }, { status: message === "TENANT_AUDIT_UNAVAILABLE" ? 503 : 400 });
        }
      },
    },
  },
});
