import { createFileRoute } from "@tanstack/react-router";
import { beatWorker, claimNext } from "@/lib/job-queue";
import { assertWorkerAccess } from "@/lib/worker-auth";

export const Route = createFileRoute("/api/worker/next")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertWorkerAccess(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const name = request.headers.get("x-worker-name") || "local";
        await beatWorker(name);
        const next = await claimNext(name);
        return Response.json(next);
      },
    },
  },
});
