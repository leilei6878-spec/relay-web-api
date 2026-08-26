import { createFileRoute } from "@tanstack/react-router";
import { assertWorker } from "@/lib/authz";
import { beatWorker, claimNext } from "@/lib/job-queue";

export const Route = createFileRoute("/api/worker/next")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertWorker(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const name = request.headers.get("x-worker-name") || "server-1";
        const stats = {
          capacity: Number(request.headers.get("x-worker-capacity") || "0") || undefined,
          activeJobs: Number(request.headers.get("x-worker-active") || "0") || undefined,
          cpu: Number(request.headers.get("x-worker-cpu") || "0") || undefined,
          ram: Number(request.headers.get("x-worker-ram") || "0") || undefined,
          browsers: Number(request.headers.get("x-worker-browsers") || "0") || undefined,
          draining: request.headers.get("x-worker-drain") === "1",
        };
        await beatWorker(name, stats);
        const next = await claimNext(name, stats);
        return Response.json(next);
      },
    },
  },
});
