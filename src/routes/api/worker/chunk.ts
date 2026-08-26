import { createFileRoute } from "@tanstack/react-router";
import { assertWorker } from "@/lib/authz";
import { getJob } from "@/lib/job-queue";
import { assertLease } from "@/lib/leases";
import { publishJobEvent } from "@/lib/job-events";

export const Route = createFileRoute("/api/worker/chunk")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await assertWorker(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as {
          id?: string;
          text?: string;
          phase?: string;
          leaseId?: string;
          fencingToken?: number;
          attemptId?: string;
        };
        if (!body.id || (!body.text && !body.phase)) return Response.json({ error: "缺少 id/text" }, { status: 400 });
        const job = await getJob(body.id);
        if (!job) return Response.json({ error: "任务不存在" }, { status: 404 });
        const proof = assertLease(job.lease, body);
        if (!proof.ok) return Response.json({ error: proof.error }, { status: 409 });
        if (body.phase) publishJobEvent(body.id, { type: "phase", phase: body.phase });
        if (body.text) publishJobEvent(body.id, { type: "delta", text: body.text });
        return Response.json({ ok: true });
      },
    },
  },
});
