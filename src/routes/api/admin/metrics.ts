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

export const Route = createFileRoute("/api/admin/metrics")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const { jobs, workers } = await listJobs();
        const plane = await readControlPlane();
        const now = Date.now();
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
        });
      },
    },
  },
});
