import { createFileRoute } from "@tanstack/react-router";
import { assertWorker } from "@/lib/authz";
import { ingestWorkerMedia } from "@/lib/worker-media";

export const Route = createFileRoute("/api/worker/media")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await assertWorker(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const jobId = request.headers.get("x-job-id") || "";
        const attemptId = request.headers.get("x-attempt-id") || "";
        const leaseId = request.headers.get("x-lease-id") || "";
        const fencingToken = Number(request.headers.get("x-fencing-token") || "0");
        const workerId = request.headers.get("x-worker-id") || request.headers.get("x-worker-name") || "";
        const mime = request.headers.get("content-type") || "image/png";
        const buf = Buffer.from(await request.arrayBuffer());
        const out = await ingestWorkerMedia({
          jobId,
          attemptId,
          leaseId,
          fencingToken: Number.isFinite(fencingToken) ? fencingToken : 0,
          workerId,
          buf,
          mime,
        });
        if (!out.ok) return Response.json({ error: out.error }, { status: out.status });
        return Response.json(out);
      },
    },
  },
});
