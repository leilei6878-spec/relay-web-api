import { createFileRoute } from "@tanstack/react-router";
import { listAudit } from "@/lib/audit";
import { assertAdmin, classify } from "@/lib/authz";
import { listUsage } from "@/lib/usage";

export const Route = createFileRoute("/api/usage")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const principal = await classify(request);
        if (!principal) return Response.json({ error: "未授权" }, { status: 401 });
        const url = new URL(request.url);
        let rows = await listUsage(2000);
        if (principal.kind === "customer") rows = rows.filter((r) => r.keyId === principal.record.id);
        else {
          const admin = await assertAdmin(request);
          if (!admin.ok) return Response.json({ error: admin.error }, { status: 401 });
        }
        if (url.searchParams.get("format") === "csv") {
          const header = "id,createdAt,keyName,model,accountEmail,ok,latencyMs,images,mode,error,promptPreview,requestId,jobId";
          const lines = rows.map((r) =>
            [r.id, r.createdAt, r.keyName, r.model, r.accountEmail, r.ok, r.latencyMs, r.images, r.mode || "", csv(r.error), csv(r.promptPreview), r.requestId || "", r.jobId || ""].join(","),
          );
          return new Response([header, ...lines].join("\n"), {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": "attachment; filename=usage.csv",
            },
          });
        }
        const audit = principal.kind === "admin" ? await listAudit(30) : [];
        return Response.json({ rows: rows.slice(0, 200), audit });
      },
    },
  },
});

function csv(value?: string) {
  const t = (value || "").replaceAll('"', '""');
  return `"${t}"`;
}
