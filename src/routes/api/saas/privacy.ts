import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession } from "@/lib/saas-auth";
import {
  cancelTenantClosure,
  createTenantDataExport,
  listTenantPrivacyRequests,
  privacyExportFilename,
  privacyRequestPublicShape,
  requestTenantClosure,
} from "@/lib/saas-privacy";
import { auditedTenantMutation } from "@/lib/tenant-audit";

function statusFor(error: string) {
  if (error === "PRIVACY_EXPORT_TOO_LARGE") return 413;
  if (error === "TENANT_AUDIT_UNAVAILABLE") return 503;
  if (/NOT_CANCELABLE|CONFLICT|duplicate|unique/i.test(error)) return 409;
  return 400;
}

export const Route = createFileRoute("/api/saas/privacy")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner"], { requireLegal: false, allowSuspended: true });
        if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
        const requests = await listTenantPrivacyRequests(auth.session.tenantId);
        return Response.json({ ok: true, requests: requests.map(privacyRequestPublicShape) }, { headers: { "Cache-Control": "no-store" } });
      },
      POST: async ({ request }) => {
        const auth = await assertSaasSession(request, ["owner"], { requireCsrf: true, forceMfa: true, requireLegal: false, allowSuspended: true });
        if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const action = String(body.action || "");
        try {
          if (action === "export") {
            const exported = await auditedTenantMutation(request, auth.session, {
              action: "privacy.export", targetType: "privacy_request",
              resultTargetId: (result) => String(result.request?.id || ""),
            }, () => createTenantDataExport(auth.session.tenantId, auth.session.userId));
            return new Response(exported.bytes, {
              status: 200,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Disposition": `attachment; filename="${privacyExportFilename(auth.session.tenantId, exported.payload.generatedAt)}"`,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Relay-Export-SHA256": exported.sha256,
              },
            });
          }
          if (action === "request-closure") {
            if (String(body.confirmTenantName || "") !== auth.session.tenantName) throw new Error("PRIVACY_CLOSURE_CONFIRMATION_MISMATCH");
            const result = await auditedTenantMutation(request, auth.session, {
              action: "privacy.closure.request", targetType: "privacy_request",
              resultTargetId: (row) => String(row.id || ""),
            }, () => requestTenantClosure(auth.session.tenantId, auth.session.userId));
            return Response.json({ ok: true, request: privacyRequestPublicShape(result) }, { status: 201, headers: { "Cache-Control": "no-store" } });
          }
          if (action === "cancel-closure") {
            const requestId = String(body.requestId || "");
            const result = await auditedTenantMutation(request, auth.session, {
              action: "privacy.closure.cancel", targetType: "privacy_request", targetId: requestId,
            }, () => cancelTenantClosure(auth.session.tenantId, auth.session.userId, requestId));
            return Response.json({ ok: true, request: privacyRequestPublicShape(result) }, { headers: { "Cache-Control": "no-store" } });
          }
          return Response.json({ ok: false, error: "UNKNOWN_ACTION" }, { status: 400 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "PRIVACY_REQUEST_FAILED";
          return Response.json({ ok: false, error: message }, { status: statusFor(message), headers: { "Cache-Control": "no-store" } });
        }
      },
    },
  },
});
