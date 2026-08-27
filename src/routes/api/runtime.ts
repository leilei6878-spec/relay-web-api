import { createFileRoute } from "@tanstack/react-router";
import { listJobs, liveWorkerOnline } from "@/lib/job-queue";
import { runProductionReadinessCheck } from "@/lib/production-guard";
import { serverWorkerStatus } from "@/lib/server-worker";
import { releaseIdentity } from "@/lib/release";

export const Route = createFileRoute("/api/runtime")({
  server: {
    handlers: {
      GET: async () => {
        const { workers, jobs } = await listJobs();
        const now = Date.now();
        const live = workers
          .filter((w) => w.name !== "preview" && !w.name.startsWith("test"))
          .map((w) => ({
            name: w.name,
            lastBeat: w.lastBeat,
            online: now - Date.parse(w.lastBeat) < 20_000,
          }));
        const production = runProductionReadinessCheck();
        return Response.json({
          release: releaseIdentity(),
          workerOnline: await liveWorkerOnline(),
          workers: live,
          queued: jobs.filter((j) => j.status === "queued" || j.status === "running").length,
          serverWorker: await serverWorkerStatus(),
          production: { ready: production.ready, production: production.production, blockers: production.blockers },
        });
      },
    },
  },
});
