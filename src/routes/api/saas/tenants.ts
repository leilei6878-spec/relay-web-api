import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession, switchSaasTenantSession } from "@/lib/saas-auth";
import { listUserSaasTenants } from "@/lib/saas-tenants";
import { auditedTenantMutation } from "@/lib/tenant-audit";

function responseWithCookies(body: unknown, cookies: string[], status = 200) {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export const Route = createFileRoute("/api/saas/tenants")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertSaasSession(request, undefined, { requireLegal: false, allowSuspended: true });
        if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
        return Response.json({ ok: true, currentTenantId: auth.session.tenantId, tenants: await listUserSaasTenants(auth.session.userId) }, { headers: { "Cache-Control": "no-store" } });
      },
      POST: async ({ request }) => {
        const auth = await assertSaasSession(request, undefined, { requireCsrf: true, requireLegal: false, allowSuspended: true });
        if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as { tenantId?: string };
        try {
          const result = await auditedTenantMutation(request, auth.session, {
            action: "tenant.switch", targetType: "tenant", targetId: String(body.tenantId || ""),
          }, () => switchSaasTenantSession(auth.session, String(body.tenantId || ""), request));
          return responseWithCookies({
            ok: true, tenant: result.tenant, csrf: result.csrf,
            mfaVerified: result.mfaVerified, legalAcceptanceRequired: result.legalAcceptanceRequired,
          }, result.cookies);
        } catch (error) {
          const message = error instanceof Error ? error.message : "TENANT_SWITCH_FAILED";
          const status = message === "TENANT_AUDIT_UNAVAILABLE" ? 503 : /NOT_ALLOWED/.test(message) ? 403 : 400;
          return Response.json({ ok: false, error: message }, { status, headers: { "Cache-Control": "no-store" } });
        }
      },
    },
  },
});
