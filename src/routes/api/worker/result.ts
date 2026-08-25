import { createFileRoute } from "@tanstack/react-router";
import { finishJob } from "@/lib/job-queue";
import { assertWorkerAccess } from "@/lib/worker-auth";

export const Route = createFileRoute("/api/worker/result")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await assertWorkerAccess(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json()) as { id?: string; ok?: boolean; text?: string; url?: string; error?: string };
        if (!body.id) return Response.json({ error: "缺少任务 id" }, { status: 400 });
        return Response.json(await finishJob(body.id, { ok: Boolean(body.ok), text: body.text, url: body.url, error: body.error }));
      },
    },
  },
});
