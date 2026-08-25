import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey, pickAccount, readControlPlane } from "@/lib/control-plane";
import { enqueueChat, liveWorkerOnline, waitJob } from "@/lib/job-queue";
import { defaultPrompt, parseMessageContent } from "@/lib/media";
import type { ApiKeyRecord } from "@/lib/api-keys";
import { fallbackChat, openPreviewChatStream } from "@/lib/upstream";
import { appendUsage } from "@/lib/usage";
import { uid } from "@/lib/utils";

type ChatBody = {
  messages?: { role?: string; content?: unknown }[];
  model?: string;
  stream?: boolean;
};

type ChatOk = {
  ok: true;
  id: string;
  model: string;
  text: string;
  accountEmail: string;
  mode: string;
};
type ChatFail = { ok: false; status: number; error: string };

export const Route = createFileRoute("/v1/chat/completions")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors() }),
      POST: async ({ request }) => {
        const auth = await assertApiKey(request, "chat");
        if (!auth.ok) {
          return Response.json({ error: { message: auth.error, type: "auth" } }, { status: auth.status, headers: cors() });
        }
        let body: ChatBody = {};
        try {
          body = (await request.json()) as ChatBody;
        } catch {
          return Response.json({ error: { message: "JSON 无效" } }, { status: 400, headers: cors() });
        }
        const last = [...(body.messages || [])].reverse().find((m) => m.role === "user");
        const parsed = parseMessageContent(last?.content);
        const prompt = defaultPrompt("chat", parsed.text, parsed.images);
        if (!prompt) {
          return Response.json({ error: { message: "缺少 user 消息或图片" } }, { status: 400, headers: cors() });
        }
        const model = body.model || "gpt-5.6";
        const started = Date.now();
        if (body.stream) return streamChat(prompt, model, parsed.images, auth.record);
        const result = await runChat(prompt, model, parsed.images);
        await appendUsage({
          keyId: auth.record.id,
          keyName: auth.record.name,
          platform: "chatgpt",
          model,
          accountEmail: result.ok ? result.accountEmail : "",
          ok: result.ok,
          latencyMs: Date.now() - started,
          images: parsed.images.length,
          promptPreview: prompt.slice(0, 80),
          error: result.ok ? undefined : result.error,
          mode: result.ok ? result.mode : undefined,
          jobId: result.ok ? result.id : undefined,
        });
        if (!result.ok) {
          return Response.json({ error: { message: result.error } }, { status: result.status, headers: cors() });
        }
        return Response.json(
          completion(result.id, result.model, result.text, result.accountEmail, result.mode, parsed.images.length),
          { headers: cors() },
        );
      },
    },
  },
});

async function runChat(prompt: string, model: string, images: string[] = []): Promise<ChatOk | ChatFail> {
  const account = await pickAccount("chatgpt");
  if (!account) {
    return { ok: false, status: 503, error: "没有可调度的健康 ChatGPT 账号（需已登录 Session + sticky）" };
  }
  const live = await liveWorkerOnline();
  if (!live) {
    const plane = await readControlPlane();
    if (!plane.settings.allowPreviewFallback) {
      return {
        ok: false,
        status: 503,
        error: "没有在线的网页执行器。请在电脑上运行本机 Worker，才能返回 ChatGPT 原文。",
      };
    }
    const fb = await fallbackChat(prompt, 60_000, images);
    if (!fb.ok) return { ok: false, status: 502, error: fb.error };
    return { ok: true, id: uid(), model, text: fb.text, accountEmail: account.email, mode: "preview" };
  }
  const queued = await enqueueChat(prompt, model, 90_000, images);
  if (!queued.ok) return { ok: false, status: 503, error: queued.error };
  const done = await waitJob(queued.job.id, queued.job.timeoutMs);
  if (!done.ok) return { ok: false, status: 504, error: done.error };
  const text = done.text || "";
  if (text.startsWith("MOCK:")) {
    return { ok: false, status: 502, error: "执行器仍是测试模式，没有返回模型原文" };
  }
  if (!text) return { ok: false, status: 504, error: "空回复" };
  return {
    ok: true,
    id: queued.job.id,
    model: queued.job.model,
    text,
    accountEmail: queued.job.accountEmail,
    mode: "live",
  };
}

function streamChat(prompt: string, model: string, images: string[], key: ApiKeyRecord) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const finish = () => controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      try {
        const account = await pickAccount("chatgpt");
        if (!account) {
          send({ error: { message: "没有可调度的健康 ChatGPT 账号（需已登录 Session + sticky）" }, relay: { phase: "error" } });
          finish();
          return;
        }
        const id = uid();
        send({
          id: `chatcmpl-${id}`,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: { role: "assistant" } }],
          relay: { phase: "start", images: images.length, accountEmail: account.email },
        });
        const live = await liveWorkerOnline();
        if (!live) {
          const plane = await readControlPlane();
          if (!plane.settings.allowPreviewFallback) {
            const msg = "没有在线的网页执行器。请在电脑上运行本机 Worker，才能返回 ChatGPT 原文。";
            send({ error: { message: msg }, relay: { phase: "error" } });
            await appendUsage({
              keyId: key.id,
              keyName: key.name,
              platform: "chatgpt",
              model,
              accountEmail: account.email,
              ok: false,
              latencyMs: 0,
              images: images.length,
              promptPreview: prompt.slice(0, 80),
              error: msg,
            });
            finish();
            return;
          }
          const up = await openPreviewChatStream(prompt, images);
          if (!up.ok) {
            send({ error: { message: up.error }, relay: { phase: "error" } });
            finish();
            return;
          }
          const decoder = new TextDecoder();
          const reader = up.body.getReader();
          let buf = "";
          while (true) {
            const step = await reader.read();
            if (step.done) break;
            buf += decoder.decode(step.value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop() || "";
            for (const part of parts) {
              const line = part.split("\n").find((l) => l.startsWith("data:"));
              if (!line) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try {
                const json = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
                const content = json.choices?.[0]?.delta?.content;
                if (content) {
                  send({
                    id: `chatcmpl-${id}`,
                    object: "chat.completion.chunk",
                    model,
                    choices: [{ index: 0, delta: { content } }],
                    relay: { phase: "streaming", accountEmail: account.email, mode: "preview", jobId: id },
                  });
                }
              } catch {
                /* skip keep-alive */
              }
            }
          }
          send({
            id: `chatcmpl-${id}`,
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            relay: { phase: "done", accountEmail: account.email, mode: "preview", jobId: id, images: images.length },
          });
          finish();
          return;
        }
        const queued = await enqueueChat(prompt, model, 90_000, images);
        if (!queued.ok) {
          send({ error: { message: queued.error }, relay: { phase: "error" } });
          finish();
          return;
        }
        send({
          id: `chatcmpl-${queued.job.id}`,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {} }],
          relay: { phase: "waiting_worker", accountEmail: queued.job.accountEmail, jobId: queued.job.id },
        });
        const result = await waitJob(queued.job.id, queued.job.timeoutMs);
        if (!result.ok || !result.text || result.text.startsWith("MOCK:")) {
          send({ error: { message: result.ok ? "执行器未返回模型原文" : result.error }, relay: { phase: "error" } });
          finish();
          return;
        }
        send({
          id: `chatcmpl-${queued.job.id}`,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: { content: result.text } }],
          relay: {
            phase: "done",
            accountEmail: queued.job.accountEmail,
            mode: "live",
            jobId: queued.job.id,
            images: images.length,
          },
        });
        send({
          id: `chatcmpl-${queued.job.id}`,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        finish();
      } catch (err) {
        send({ error: { message: err instanceof Error ? err.message : "流式失败" }, relay: { phase: "error" } });
        finish();
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...cors(),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function completion(id: string, model: string, content: string, accountEmail: string, mode: string, imageCount = 0) {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    relay: { accountEmail, jobId: id, mode, images: imageCount },
  };
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-api-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
