import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession } from "@/lib/saas-auth";
import {
  listUserSaasSessions,
  revokeOtherSaasSessions,
  revokeUserSaasSession,
  rotateSaasRecoveryCodes,
} from "@/lib/saas-session-security";
import { auditedTenantMutation } from "@/lib/tenant-audit";

function statusFor(error: string) {
  if (error === "TENANT_AUDIT_UNAVAILABLE" || error === "MFA_RECOVERY_ROTATION_UNAVAILABLE") return 503;
  if (/NOT_REVOCABLE|CURRENT_REQUIRES_LOGOUT|ROTATION_IN_PROGRESS/.test(error)) return 409;
  return 400;
}

export const Route = createFileRoute("/api/saas/security")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertSaasSession(request, undefined, { requireLegal: false, allowSuspended: true });
        if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
        return Response.json({
          ok: true,
          sessions: await listUserSaasSessions(auth.session.userId, auth.session.sessionId),
        }, { headers: { "Cache-Control": "no-store" } });
      },
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const action = String(body.action || "");
        const auth = await assertSaasSession(request, undefined, {
          requireCsrf: true,
          forceMfa: action === "rotate-recovery-codes",
          requireLegal: false,
          allowSuspended: true,
        });
        if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
        try {
          if (action === "revoke-session") {
            const sessionId = String(body.sessionId || "");
            const result = await auditedTenantMutation(request, auth.session, {
              action: "session.revoke", targetType: "saas_session", targetId: sessionId,
            }, () => revokeUserSaasSession(auth.session.userId, auth.session.sessionId, sessionId));
            return Response.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
          }
          if (action === "revoke-other-sessions") {
            const result = await auditedTenantMutation(request, auth.session, {
              action: "session.revoke_others", targetType: "saas_user", targetId: auth.session.userId,
            }, () => revokeOtherSaasSessions(auth.session.userId, auth.session.sessionId));
            return Response.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
          }
          if (action === "rotate-recovery-codes") {
            const result = await auditedTenantMutation(request, auth.session, {
              action: "mfa.recovery.rotate", targetType: "saas_user", targetId: auth.session.userId,
            }, () => rotateSaasRecoveryCodes(auth.session));
            return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
          }
          return Response.json({ ok: false, error: "UNKNOWN_ACTION" }, { status: 400 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "SAAS_SECURITY_FAILED";
          return Response.json({ ok: false, error: message }, { status: statusFor(message), headers: { "Cache-Control": "no-store" } });
        }
      },
    },
  },
});
