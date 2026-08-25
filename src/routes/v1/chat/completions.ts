import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey } from "@/lib/control-plane";
import { enqueueChat, waitJob } from "@/lib/job-queue";

export const Route = createFileRoute("/v1/chat/completions")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: cors(),
        }),
      POST: async ({ request }) => {
        const auth = await assertApiKey(request);
        if (!auth.ok) {
          return Response.json({ error: { message: auth.error, type: "auth" } }, { status: auth.status, headers: cors() });
        }
        let body: { messages?: { role?: string; content?: string }[]; model?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: { message: "JSON 无效" } }, { status: 400, headers: cors() });
        }
        const prompt = [...(body.messages || [])].reverse().find((m) => m.role === "user")?.content?.trim() || "";
        if (!prompt) {
          return Response.json({ error: { message: "缺少 user 消息" } }, { status: 400, headers: cors() });
        }
        const queued = await enqueueChat(prompt, body.model || "gpt-4o");
        if (!queued.ok) {
          return Response.json({ error: { message: queued.error, type: "no_account" } }, { status: 503, headers: cors() });
        }
        const done = await waitJob(queued.job.id, queued.job.timeoutMs);
        if (!done.ok) {
          return Response.json({ error: { message: done.error } }, { status: 504, headers: cors() });
        }
        return Response.json(
          {
            id: `chatcmpl-${queued.job.id}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: queued.job.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: done.text },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
