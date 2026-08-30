import { createFileRoute } from "@tanstack/react-router";
import { assertAdmin } from "@/lib/authz";
import { browserBaseline } from "@/lib/browser-baseline";
import { getCircuit } from "@/lib/circuit";
import { coordBackend } from "@/lib/coord";
import { listJobs } from "@/lib/job-queue";
import { metricsSnapshot } from "@/lib/metrics";
import { objectStoreConfigured } from "@/lib/media-store";
import { persistenceMode } from "@/lib/persist-mode";
import { runProductionReadinessCheck } from "@/lib/production-guard";
import { readControlPlane } from "@/lib/control-plane";
import { dbSource } from "@/lib/db";
import { getSql } from "@/lib/db";
import { commercialReadiness } from "@/lib/commercial-readiness";

export const Route = createFileRoute("/api/admin/metrics")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const { jobs, workers } = await listJobs();
        const plane = await readControlPlane();
        const now = Date.now();
        const sql = await getSql();
        const [tenantRows, chargeRows, alertRows] = await Promise.all([
          sql.query<{ total: number; active: number }>("select count(*)::int as total,count(*) filter(where status in ('trial','active'))::int as active from relay_tenants"),
          sql.query<{ reserved: number; settled: number; charged: number }>("select count(*) filter(where status='reserved')::int as reserved,count(*) filter(where status='settled')::int as settled,coalesce(sum(charged_minor) filter(where status='settled'),0)::bigint as charged from relay_usage_charges"),
          sql.query<{ open: number; critical: number; deliveryPending: number; deliveryFailed: number; emailPending: number; emailFailed: number }>(
            `select count(*) filter(where status='open')::int as open,
                    count(*) filter(where status='open' and severity='critical')::int as critical,
                    (select count(*)::int from relay_alert_deliveries where status in ('pending','sending','not_configured')) as "deliveryPending",
                    (select count(*)::int from relay_alert_deliveries where status='retrying') as "deliveryFailed",
                    (select count(*)::int from relay_email_deliveries where status in ('pending','sending','not_configured')) as "emailPending",
                    (select count(*)::int from relay_email_deliveries where status='retrying') as "emailFailed"
               from relay_alert_events`,
          ),
        ]);
        return Response.json({
          slo: metricsSnapshot(),
          queueDepth: jobs.filter((j) => j.status === "queued" || j.status === "running").length,
          deadLetter: jobs.filter((j) => j.status === "dead").length,
          workers: workers.map((w) => ({
            name: w.name,
            online: now - Date.parse(w.lastBeat) < 20_000,
            capacity: w.capacity,
            activeJobs: w.activeJobs,
            browsers: w.browsers,
            draining: w.draining,
            cpu: w.cpu,
            ram: w.ram,
          })),
          accounts: {
            healthy: plane.accounts.filter((a) => a.status === "healthy").length,
            probing: plane.accounts.filter((a) => a.status === "probing").length,
            cooling: plane.accounts.filter((a) => a.status === "cooling").length,
            invalid: plane.accounts.filter((a) => a.status === "invalid").length,
            banned: plane.accounts.filter((a) => a.status === "banned").length,
            canary: plane.accounts.filter((a) => a.canary).length,
          },
          backend: {
            db: dbSource,
            persist: persistenceMode(),
            coord: coordBackend(),
            media: objectStoreConfigured() ? "object" : "local",
          },
          circuit: {
            chatgpt: await getCircuit("chatgpt"),
            gemini: await getCircuit("gemini"),
          },
          browser: browserBaseline(),
          production: runProductionReadinessCheck(),
          commercial: {
            readiness: await commercialReadiness(),
            tenants: tenantRows[0] || { total: 0, active: 0 },
            charges: chargeRows[0] || { reserved: 0, settled: 0, charged: 0 },
            alerts: alertRows[0] || { open: 0, critical: 0 },
          },
        });
      },
    },
  },
});
