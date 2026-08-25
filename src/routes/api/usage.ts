import { createFileRoute } from "@tanstack/react-router";
import { listAudit } from "@/lib/audit";
import { assertApiKey } from "@/lib/control-plane";
import { listUsage } from "@/lib/usage";

export const Route = createFileRoute("/api/usage")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertApiKey(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const url = new URL(request.url);
        const rows = await listUsage(2000);
        if (url.searchParams.get("format") === "csv") {
          const header = "id,createdAt,keyName,model,accountEmail,ok,latencyMs,images,mode,error,promptPreview";
          const lines = rows.map((r) =>
            [r.id, r.createdAt, r.keyName, r.model, r.accountEmail, r.ok, r.latencyMs, r.images, r.mode || "", csv(r.error), csv(r.promptPreview)].join(","),
          );
          return new Response([header, ...lines].join("\n"), {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": "attachment; filename=usage.csv",
            },
          });
        }
        const audit = await listAudit(30);
        return Response.json({ rows: rows.slice(0, 200), audit });
      },
    },
  },
});

function csv(value?: string) {
  const t = (value || "").replaceAll('"', '""');
  return `"${t}"`;
}
