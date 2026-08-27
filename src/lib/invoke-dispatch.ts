import { handleChat } from "@/routes/v1/chat/completions";
import { handleImage } from "@/routes/v1/images/generations";
import { MODELS } from "@/routes/v1/models";
import { handleGenerateContent } from "@/routes/v1beta/models/$";
import { normalizeInvokePath } from "./invoke-path";

function innerRequest(path: string, apiKey: string, payload: unknown, method: string, signal?: AbortSignal) {
  return new Request(`http://relay.internal${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
    signal,
  });
}

function responsesAsChat(payload: unknown) {
  const p = (payload || {}) as Record<string, unknown>;
  if (Array.isArray(p.messages)) return { model: p.model, messages: p.messages, stream: p.stream };
  const items = Array.isArray(p.input) ? p.input : p.input != null ? [p.input] : [];
  const messages: { role: string; content: unknown }[] = [];
  for (const item of items) {
    if (typeof item === "string") messages.push({ role: "user", content: item });
    else if (item && typeof item === "object") {
      const rec = item as { role?: string; content?: unknown; text?: string };
      if (rec.content != null) messages.push({ role: rec.role || "user", content: rec.content });
      else if (typeof rec.text === "string") messages.push({ role: "user", content: rec.text });
    }
  }
  return { model: p.model, messages, stream: p.stream };
}

async function asInvokeResponse(res: Response) {
  const headers = new Headers(res.headers);
  headers.set("x-relay-invoke", "in-process");
  const ctype = headers.get("content-type") || "application/json";
  if (ctype.includes("text/event-stream") && res.body) {
    return new Response(res.body, { status: res.status, headers });
  }
  const text = await res.text();
  if (!text.trim()) {
    return Response.json(
      {
        error: {
          message:
            res.status === 504
              ? "TIMEOUT: 图生图超时，网关没有返回内容。请确认参考图已挂上后重试。"
              : `HTTP ${res.status || 0}：空响应`,
        },
      },
      { status: res.status === 200 ? 502 : res.status || 502, headers: { "Content-Type": "application/json", "x-relay-invoke": "in-process" } },
    );
  }
  headers.set("Content-Type", ctype.includes("json") ? ctype : "application/json");
  return new Response(text, { status: res.status, headers });
}

/** In-process OpenAI/Google handlers. Never HTTP-fetch the public preview origin. */
export async function dispatchAdminInvoke(opts: {
  path: string;
  payload?: unknown;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const path = normalizeInvokePath(opts.path || "");
  try {
    if (path === "/v1/models") {
      return asInvokeResponse(Response.json({ object: "list", data: MODELS }));
    }
    if (path === "/v1/images/generations") {
      return asInvokeResponse(
        await handleImage(innerRequest(path, opts.apiKey, opts.payload, "POST", opts.signal), "image"),
      );
    }
    if (path === "/v1/images/edits") {
      return asInvokeResponse(
        await handleImage(innerRequest(path, opts.apiKey, opts.payload, "POST", opts.signal), "edit"),
      );
    }
    if (path.startsWith("/v1beta/models/")) {
      const splat = path.slice("/v1beta/models/".length);
      return asInvokeResponse(
        await handleGenerateContent(innerRequest(path, opts.apiKey, opts.payload, "POST", opts.signal), splat),
      );
    }
    const payload = path === "/v1/responses" ? responsesAsChat(opts.payload) : opts.payload;
    return asInvokeResponse(
      await handleChat(innerRequest("/v1/chat/completions", opts.apiKey, payload, "POST", opts.signal)),
    );
  } catch (err) {
    const timedOut = (err as { name?: string }).name === "AbortError" || opts.signal?.aborted;
    return Response.json(
      {
        error: {
          message: timedOut
            ? "TIMEOUT: 图生图/对话在时限内没有返回。参考图任务请确认图片已挂上后再试。"
            : err instanceof Error
              ? err.message
              : "invoke failed",
        },
      },
      { status: timedOut ? 504 : 502, headers: { "x-relay-invoke": "in-process" } },
    );
  }
}
