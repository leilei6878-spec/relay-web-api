import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey } from "@/lib/control-plane";
import { parseMessageContent } from "@/lib/media";
import { prepareChatRequest } from "@/lib/provider/index";
import { estimateTokens } from "@/lib/tokens";
import { ingestReferenceImages } from "@/lib/reference-input";
import { runChat, streamChat } from "./chat/completions";
import { publicRelayMeta } from "@/lib/public-relay-meta";

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
        let imageOverflow = false;
        let imageInvalid = false;
        for (const item of items) {
          if (typeof item === "string") messages.push({ role: "user", content: item });
          else if (item && typeof item === "object") {
            if (item.role || item.content != null) {
              messages.push({ role: item.role || "user", content: item.content ?? item.text });
            } else if (item.text) {
              messages.push({ role: "user", content: item.text });
            } else {
              const parsed = parseMessageContent(item);
              imageOverflow ||= parsed.imageOverflow;
              imageInvalid ||= parsed.imageInvalid;
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
        imageOverflow ||= messages.some((message) => parseMessageContent(message.content).imageOverflow);
        imageInvalid ||= messages.some((message) => parseMessageContent(message.content).imageInvalid);
        if (imageInvalid) {
          return Response.json(
            { error: { message: "unsupported parameter: invalid input image", type: "invalid_request_error" } },
            { status: 400, headers: cors() },
          );
        }
        if (imageOverflow) {
          return Response.json(
            { error: { message: "unsupported parameter: input images max 4", type: "invalid_request_error" } },
            { status: 400, headers: cors() },
          );
        }
        const prepared = prepareChatRequest("chatgpt", { messages, model: body.model || "chatgpt-web-auto" });
        if (!prepared.webPrompt && !prepared.images.length) {
          return Response.json({ error: { message: "缺少 input" } }, { status: 400, headers: cors() });
        }
        const idem = request.headers.get("idempotency-key") || undefined;
        const requestId = request.headers.get("x-request-id") || undefined;
        const frozen = await ingestReferenceImages(prepared.images, new URL(request.url).origin);
        if (!frozen.ok) {
          return Response.json(
            { error: { message: frozen.error, type: "invalid_request_error" } },
            { status: 400, headers: cors() },
          );
        }
        const imageMap = new Map(prepared.images.map((url, index) => [url, frozen.assets[index]?.url || url]));
        const frozenImages = frozen.assets.map((asset) => asset.url);
        const frozenTurns = prepared.turns.map((turn) => ({
          ...turn,
          images: turn.images?.map((url) => imageMap.get(url) || url),
        }));
        if (body.stream) {
          const key = auth.record;
          return streamChat(
            prepared.webPrompt,
            prepared.model,
            frozenImages,
            key,
            idem,
            requestId,
            request.signal,
            frozenTurns,
            prepared.selectorPackVersion,
            frozen.assets,
          );
        }
        const result = await runChat(
          prepared.webPrompt,
          prepared.model,
          frozenImages,
          idem,
          requestId,
          auth.record.id,
          frozenTurns,
          prepared.selectorPackVersion,
          frozen.assets,
        );
        if (!result.ok) {
          return Response.json(
            { error: { message: result.error } },
            { status: result.status, headers: result.status === 429 ? { ...cors(), "Retry-After": "5" } : cors() },
          );
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
            relay: publicRelayMeta({
              accountEmail: result.accountEmail,
              jobId: result.id,
              mode: result.mode,
              requestId: result.requestId,
              attemptId: result.attemptId,
              workerId: result.workerId,
              requested_model: prepared.model,
              actual_model: result.actualModel || "unknown",
              actual_model_label: result.actualModelLabel,
              model_verified: result.modelVerified ?? false,
              requested_profile: result.requestedProfile || "exact",
              actual_profile: result.actualProfile || "unknown",
              profile_verified: result.profileVerified ?? false,
            }),
          },
          { headers: cors() },
        );
      },
    },
  },
});
