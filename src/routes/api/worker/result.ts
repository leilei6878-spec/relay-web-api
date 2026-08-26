import { createFileRoute } from "@tanstack/react-router";
import { assertWorker } from "@/lib/authz";
import { finishJob } from "@/lib/job-queue";

export const Route = createFileRoute("/api/worker/result")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await assertWorker(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json()) as {
          id?: string;
          ok?: boolean;
          text?: string;
          url?: string;
          error?: string;
          fault?: string;
          leaseId?: string;
          fencingToken?: number;
          attemptId?: string;
          workerId?: string;
          sessionState?: unknown;
          sessionVersion?: number;
          sessionBaseVersion?: number;
          modelActual?: string;
          pageState?: string;
          fingerprint?: unknown;
          selectorPackVersion?: string;
        };
        if (!body.id) return Response.json({ error: "缺少任务 id" }, { status: 400 });
        return Response.json(
          await finishJob(body.id, {
            ok: Boolean(body.ok),
            text: body.text,
            url: body.url,
            error: body.error,
            fault: body.fault,
            leaseId: body.leaseId,
            fencingToken: body.fencingToken,
            attemptId: body.attemptId,
            workerId: body.workerId,
            sessionState: body.sessionState,
            sessionVersion: body.sessionVersion,
            sessionBaseVersion: body.sessionBaseVersion,
            modelActual: body.modelActual,
            pageState: body.pageState,
            selectorPackVersion: body.selectorPackVersion,
          }),
        );
      },
    },
  },
});
