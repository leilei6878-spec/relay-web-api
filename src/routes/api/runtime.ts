import { createFileRoute } from "@tanstack/react-router";
import { ensureApiKey } from "@/lib/control-plane";
import { listJobs } from "@/lib/job-queue";

export const Route = createFileRoute("/api/runtime")({
  server: {
    handlers: {
      GET: async () => {
        const apiKey = await ensureApiKey();
        const { workers } = await listJobs();
        const workerOnline = workers.some((w) => Date.now() - Date.parse(w.lastBeat) < 15_000);
        return Response.json({ apiKey, workerOnline });
      },
    },
  },
});
