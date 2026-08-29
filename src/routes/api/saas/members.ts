import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession } from "@/lib/saas-auth";
import { inviteTenantMember, listTenantMembers, updateTenantMemberRole } from "@/lib/saas-members";
import type { TenantRole } from "@/lib/commercial-types";

export const Route = createFileRoute("/api/saas/members")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertSaasSession(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        return Response.json({ members: await listTenantMembers(auth.session.tenantId) });
      },
      POST: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner", "admin"], { requireCsrf: true });
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as { email?: string; role?: TenantRole };
        try {
          return Response.json(await inviteTenantMember(auth.session, { email: body.email || "", role: body.role || "viewer" }), { status: 201 });
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : "INVITE_FAILED" }, { status: 400 });
        }
      },
      PATCH: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner", "admin"], { requireCsrf: true });
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as { userId?: string; role?: TenantRole; status?: "active" | "disabled" };
        try {
          return Response.json(await updateTenantMemberRole(auth.session, body.userId || "", body.role || "viewer", body.status || "active"));
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : "MEMBER_UPDATE_FAILED" }, { status: 400 });
        }
      },
    },
  },
});
