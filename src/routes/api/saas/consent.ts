import { createFileRoute } from "@tanstack/react-router";
import { assertSaasSession } from "@/lib/saas-auth";
import { recordLegalReconsent } from "@/lib/legal-documents";
import { auditedTenantMutation } from "@/lib/tenant-audit";

export const Route = createFileRoute("/api/saas/consent")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await assertSaasSession(request, undefined, { requireCsrf: true, requireLegal: false });
        if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
        const body = (await request.json().catch(() => ({}))) as {
          accepted?: boolean; termsVersion?: string; privacyVersion?: string; bundleSha256?: string;
        };
        try {
          const result = await auditedTenantMutation(request, auth.session, {
            action: "legal.accept", targetType: "legal_document_bundle",
          }, () => recordLegalReconsent({
            userId: auth.session.userId, tenantId: auth.session.tenantId, accepted: body.accepted === true,
            termsVersion: body.termsVersion || "", privacyVersion: body.privacyVersion || "",
            bundleSha256: body.bundleSha256 || "",
          }, request));
          return Response.json(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : "LEGAL_ACCEPTANCE_FAILED";
          return Response.json({ ok: false, error: message }, { status: message === "TENANT_AUDIT_UNAVAILABLE" ? 503 : 400 });
        }
      },
    },
  },
});

