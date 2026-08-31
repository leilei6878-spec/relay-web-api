import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession } from "@/lib/saas-auth";
import { inviteTenantMember, listTenantInvites, listTenantMembers, resendTenantInvite, revokeTenantInvite, transferTenantOwnership, updateTenantMemberRole } from "@/lib/saas-members";
import { auditedTenantMutation } from "@/lib/tenant-audit";
import type { TenantRole } from "@/lib/commercial-types";

export const Route = createFileRoute("/api/saas/members")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertSaasSession(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const [members, invites] = await Promise.all([
          listTenantMembers(auth.session.tenantId),
          ["owner", "admin"].includes(auth.session.role) ? listTenantInvites(auth.session) : Promise.resolve([]),
        ]);
        return Response.json({ members, invites });
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
          return memberErrorResponse(message);
        }
      },
      PATCH: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner", "admin"], { requireCsrf: true, requireMfa: true });
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as { action?: string; userId?: string; inviteId?: string; role?: TenantRole; status?: "active" | "disabled" };
        try {
          if (body.action === "transfer-ownership") {
            const transferAuth = await assertSaasSession(request, ["owner"], { requireCsrf: true, forceMfa: true });
            if (!transferAuth.ok) return Response.json({ error: transferAuth.error }, { status: transferAuth.status });
            return Response.json(await auditedTenantMutation(request, transferAuth.session, {
              action: "ownership.transfer", targetType: "tenant_member", targetId: body.userId || null,
            }, () => transferTenantOwnership(transferAuth.session, body.userId || "")));
          }
          if (body.action === "resend-invite") {
            return Response.json(await auditedTenantMutation(request, auth.session, {
              action: "member.invite.resend", targetType: "tenant_invite", targetId: body.inviteId || null,
            }, () => resendTenantInvite(auth.session, body.inviteId || "")));
          }
          const role = body.role || "viewer";
          const status = body.status || "active";
          return Response.json(await auditedTenantMutation(request, auth.session, {
            action: "member.update", targetType: "tenant_member", targetId: body.userId || null,
            detail: { role, status },
          }, () => updateTenantMemberRole(auth.session, body.userId || "", role, status)));
        } catch (error) {
          const message = error instanceof Error ? error.message : "MEMBER_UPDATE_FAILED";
          return memberErrorResponse(message);
        }
      },
      DELETE: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner", "admin"], { requireCsrf: true, requireMfa: true });
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as { inviteId?: string };
        try {
          return Response.json(await auditedTenantMutation(request, auth.session, {
            action: "member.invite.revoke", targetType: "tenant_invite", targetId: body.inviteId || null,
          }, () => revokeTenantInvite(auth.session, body.inviteId || "")));
        } catch (error) {
          const message = error instanceof Error ? error.message : "INVITE_REVOKE_FAILED";
          return memberErrorResponse(message);
        }
      },
    },
  },
});

function memberErrorResponse(message: string) {
  const status = message === "TENANT_AUDIT_UNAVAILABLE" ? 503 : message === "INVITE_RESEND_COOLDOWN" ? 429 : 400;
  return Response.json({ ok: false, error: message }, {
    status,
    headers: status === 429 ? { "Retry-After": "60" } : undefined,
  });
}
