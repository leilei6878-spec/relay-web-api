import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey } from "@/lib/control-plane";
import { enqueueImage, waitJob } from "@/lib/job-queue";

export const Route = createFileRoute("/v1/images/generations")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors() }),
      POST: async ({ request }) => {
        const auth = await assertApiKey(request);
        if (!auth.ok) {
          return Response.json({ error: { message: auth.error } }, { status: auth.status, headers: cors() });
        }
        let body: { prompt?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: { message: "JSON 无效" } }, { status: 400, headers: cors() });
        }
        const prompt = body.prompt?.trim() || "";
        if (!prompt) {
          return Response.json({ error: { message: "缺少 prompt" } }, { status: 400, headers: cors() });
        }
        const queued = await enqueueImage(prompt);
        if (!queued.ok) {
          return Response.json({ error: { message: queued.error } }, { status: 503, headers: cors() });
        }
        const done = await waitJob(queued.job.id, queued.job.timeoutMs);
        if (!done.ok || !done.url) {
          return Response.json({ error: { message: done.ok ? "未返回图片" : done.error } }, { status: 504, headers: cors() });
        }
        return Response.json(
          {
            created: Math.floor(Date.now() / 1000),
            data: [{ url: done.url }],
            relay: { accountEmail: queued.job.accountEmail, jobId: queued.job.id },
          },
          { headers: cors() },
        );
      },
    },
  },
});

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-api-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
