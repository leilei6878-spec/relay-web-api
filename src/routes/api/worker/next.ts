import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey } from "@/lib/control-plane";
import { beatWorker, claimNext } from "@/lib/job-queue";

export const Route = createFileRoute("/api/worker/next")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertApiKey(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        await beatWorker(request.headers.get("x-worker-name") || "local");
        const next = await claimNext();
        return Response.json(next);
      },
    },
  },
});
