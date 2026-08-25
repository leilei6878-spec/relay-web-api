import { createFileRoute } from "@tanstack/react-router";
import { primaryApiKey } from "@/lib/api-keys";
import { listJobs, liveWorkerOnline } from "@/lib/job-queue";
import { ensureServerWorker, serverWorkerStatus } from "@/lib/server-worker";
import { ensureWorkerToken } from "@/lib/worker-auth";

export const Route = createFileRoute("/api/runtime")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        const gw = origin.includes("localhost") ? "http://127.0.0.1:8080" : origin;
        await ensureServerWorker(gw);
        const apiKey = await primaryApiKey();
        const workerToken = await ensureWorkerToken();
        const { workers, jobs } = await listJobs();
        const now = Date.now();
        const live = workers
          .filter((w) => w.name !== "preview" && !w.name.startsWith("test"))
          .map((w) => ({
            name: w.name,
            lastBeat: w.lastBeat,
            online: now - Date.parse(w.lastBeat) < 20_000,
          }));
        return Response.json({
          apiKey,
          workerToken,
          workerOnline: await liveWorkerOnline(),
          workers: live,
          queued: jobs.filter((j) => j.status === "queued" || j.status === "running").length,
          serverWorker: await serverWorkerStatus(),
        });
      },
    },
  },
});
