import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession } from "@/lib/saas-auth";
import { listTenantAuditEvents } from "@/lib/tenant-audit";

export const Route = createFileRoute("/api/saas/audit")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner", "admin"]);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const rawLimit = Number(new URL(request.url).searchParams.get("limit") || 100);
        const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
        return Response.json(
          { events: await listTenantAuditEvents(auth.session.tenantId, limit) },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
