import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession } from "@/lib/saas-auth";
import { inviteTenantMember, listTenantMembers, updateTenantMemberRole } from "@/lib/saas-members";
import { auditedTenantMutation } from "@/lib/tenant-audit";
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
        const auth = await assertSaasSession(request, ["owner", "admin"], { requireCsrf: true, requireMfa: true });
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as { email?: string; role?: TenantRole };
        try {
          const role = body.role || "viewer";
          const result = await auditedTenantMutation(request, auth.session, {
            action: "member.invite", targetType: "tenant_invite", detail: { role },
            resultTargetId: (value) => value.inviteId,
          }, () => inviteTenantMember(auth.session, { email: body.email || "", role }));
          return Response.json(result, { status: 201 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "INVITE_FAILED";
          return Response.json({ ok: false, error: message }, { status: message === "TENANT_AUDIT_UNAVAILABLE" ? 503 : 400 });
        }
      },
      PATCH: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner", "admin"], { requireCsrf: true, requireMfa: true });
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as { userId?: string; role?: TenantRole; status?: "active" | "disabled" };
        try {
          const role = body.role || "viewer";
          const status = body.status || "active";
          return Response.json(await auditedTenantMutation(request, auth.session, {
            action: "member.update", targetType: "tenant_member", targetId: body.userId || null,
            detail: { role, status },
          }, () => updateTenantMemberRole(auth.session, body.userId || "", role, status)));
        } catch (error) {
          const message = error instanceof Error ? error.message : "MEMBER_UPDATE_FAILED";
          return Response.json({ ok: false, error: message }, { status: message === "TENANT_AUDIT_UNAVAILABLE" ? 503 : 400 });
        }
      },
    },
  },
});
