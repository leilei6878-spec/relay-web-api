import { createFileRoute } from "@tanstack/react-router";
import { assertAdminMfa } from "@/lib/authz";
import { effectiveCommercialEnv } from "@/lib/commercial-config";
import {
  COMMERCIAL_EVIDENCE_CATALOG,
  commercialEvidenceStatus,
  listCommercialEvidence,
  recordCommercialEvidence,
  type CommercialEvidenceRequirement,
} from "@/lib/commercial-evidence";
import { getSql } from "@/lib/db";

async function snapshot() {
  const sql = await getSql();
  const env = await effectiveCommercialEnv(process.env, sql);
  return {
    catalog: COMMERCIAL_EVIDENCE_CATALOG,
    requirements: await commercialEvidenceStatus(env, sql),
    history: await listCommercialEvidence(sql),
  };
}

export const Route = createFileRoute("/api/admin/commercial-evidence")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdminMfa(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        return Response.json(await snapshot(), { headers: { "Cache-Control": "no-store" } });
      },
      POST: async ({ request }) => {
        const auth = await assertAdminMfa(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        try {
          const evidence = await recordCommercialEvidence({
            requirement: String(body.requirement || "") as CommercialEvidenceRequirement,
            subject: String(body.subject || "global"),
            status: String(body.status || "passed") as "passed" | "failed" | "revoked",
            artifactRef: String(body.artifactRef || ""),
            artifactSha256: String(body.artifactSha256 || ""),
            note: String(body.note || ""),
            reviewer: String(body.reviewer || ""),
            observedAt: String(body.observedAt || ""),
            validUntil: String(body.validUntil || ""),
            confirmation: String(body.confirmation || ""),
            actor: "admin",
          });
          return Response.json({ ok: true, evidence, ...(await snapshot()) });
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : "COMMERCIAL_EVIDENCE_FAILED" }, { status: 400 });
        }
      },
    },
  },
});
