import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey } from "@/lib/control-plane";
import { listJobs } from "@/lib/job-queue";
import { getSql } from "@/lib/db";
import type { CommercialApiKey } from "@/lib/commercial-types";

export const Route = createFileRoute("/api/jobs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertApiKey(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        if (auth.commercial) {
          const key = auth.record as CommercialApiKey;
          const sql = await getSql();
          const jobs = await sql.query(
            `select request_id as id,status,provider,model,capability,created_at,settled_at,charged_minor
               from relay_usage_charges where tenant_id=$1 order by created_at desc limit 20`,
            [key.tenantId],
          );
          return Response.json({ jobs, workers: [] });
        }
        const store = await listJobs();
        const now = Date.now();
        return Response.json({
          jobs: store.jobs.slice(0, 20).map((j) => ({
            id: j.id,
            status: j.status,
            platform: j.platform,
            model: j.model,
            accountEmail: j.accountEmail,
            createdAt: j.createdAt,
            error: j.error,
            hasText: Boolean(j.text),
            hasUrl: Boolean(j.url),
            preview: (j.text || "").slice(0, 80),
          })),
          workers: store.workers.map((w) => ({
            name: w.name,
            online: now - Date.parse(w.lastBeat) < 20_000,
            lastBeat: w.lastBeat,
          })),
        });
      },
    },
  },
});
