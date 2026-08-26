import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey } from "@/lib/control-plane";
import { parseMessageContent } from "@/lib/media";
import { prepareChatRequest } from "@/lib/provider/index";
import { estimateTokens } from "@/lib/tokens";
import { runChat, streamChat } from "./chat/completions";

const ALLOWED = new Set(["model", "input", "stream"]);

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-api-key, idempotency-key, x-request-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

type InputItem =
  | string
  | {
      type?: string;
      text?: string;
      role?: string;
      content?: unknown;
    };

export const Route = createFileRoute("/v1/responses")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors() }),
      POST: async ({ request }) => {
        const auth = await assertApiKey(request, "chat");
        if (!auth.ok) {
          return Response.json({ error: { message: auth.error } }, { status: auth.status, headers: cors() });
        }
        const body = (await request.json().catch(() => ({}))) as {
          model?: string;
          input?: InputItem | InputItem[];
          stream?: boolean;
          [k: string]: unknown;
        };
        const unsupported = Object.keys(body).filter((k) => !ALLOWED.has(k));
        if (unsupported.length) {
          return Response.json(
            { error: { message: `unsupported parameter: ${unsupported.join(", ")}`, type: "invalid_request_error" } },
            { status: 400, headers: cors() },
          );
        }
        const items = Array.isArray(body.input) ? body.input : body.input != null ? [body.input] : [];
        const messages: { role?: string; content?: unknown }[] = [];
        for (const item of items) {
          if (typeof item === "string") messages.push({ role: "user", content: item });
          else if (item && typeof item === "object") {
            if (item.role || item.content != null) {
              messages.push({ role: item.role || "user", content: item.content ?? item.text });
            } else if (item.text) {
              messages.push({ role: "user", content: item.text });
            } else {
              const parsed = parseMessageContent(item);
              if (parsed.text || parsed.images.length) {
                messages.push({
                  role: "user",
                  content: [
                    ...(parsed.text ? [{ type: "text", text: parsed.text }] : []),
                    ...parsed.images.map((url) => ({ type: "image_url", image_url: { url } })),
                  ],
                });
              }
            }
          }
        }
        const prepared = prepareChatRequest("chatgpt", { messages, model: body.model || "gpt-5.6" });
        if (!prepared.webPrompt && !prepared.images.length) {
          return Response.json({ error: { message: "缺少 input" } }, { status: 400, headers: cors() });
        }
        const idem = request.headers.get("idempotency-key") || undefined;
        const requestId = request.headers.get("x-request-id") || undefined;
        if (body.stream) {
          const key = auth.record;
          return streamChat(
            prepared.webPrompt,
            prepared.model,
            prepared.images,
            key,
            idem,
            requestId,
            request.signal,
            prepared.turns,
            prepared.selectorPackVersion,
          );
        }
        const result = await runChat(
          prepared.webPrompt,
          prepared.model,
          prepared.images,
          idem,
          requestId,
          auth.record.id,
          prepared.turns,
          prepared.selectorPackVersion,
        );
        if (!result.ok) {
          return Response.json({ error: { message: result.error } }, { status: result.status, headers: cors() });
        }
        return Response.json(
          {
            id: `resp-${result.id}`,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            model: result.model,
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: result.text }],
              },
            ],
            usage: {
              input_tokens: estimateTokens(prepared.webPrompt),
              output_tokens: estimateTokens(result.text),
              total_tokens: estimateTokens(prepared.webPrompt) + estimateTokens(result.text),
            },
            relay: {
              accountEmail: result.accountEmail,
              jobId: result.id,
              mode: result.mode,
              requestId: result.requestId,
              attemptId: result.attemptId,
              workerId: result.workerId,
              requested_model: prepared.model,
            },
          },
          { headers: cors() },
        );
      },
    },
  },
});
