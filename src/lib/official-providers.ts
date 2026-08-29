import { effectiveCommercialEnv } from "./commercial-config";
import type { Sql } from "./db";

export type OfficialProvider = "openai" | "google" | "leonardo";

export type ResolvedOfficialModel = {
  provider: OfficialProvider;
  model: string;
  publicModel: string;
};

export type OfficialChatResult =
  | {
      ok: true;
      provider: OfficialProvider;
      model: string;
      id: string;
      text: string;
      promptTokens: number;
      completionTokens: number;
      finishReason: string;
      raw: Record<string, unknown>;
    }
  | { ok: false; provider: OfficialProvider; status: number; error: string; code: string };

export type OfficialImageResult =
  | {
      ok: true;
      provider: OfficialProvider;
      model: string;
      id: string;
      images: { url?: string; b64_json?: string; revised_prompt?: string }[];
      promptTokens: number;
      completionTokens: number;
      raw: Record<string, unknown>;
    }
  | { ok: false; provider: OfficialProvider; status: number; error: string; code: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(body: unknown, fallback: string) {
  const root = record(body);
  const error = record(root.error);
  return String(error.message || root.message || root.error || fallback).slice(0, 1200);
}

export function resolveOfficialModel(input: string): ResolvedOfficialModel {
  const raw = input.trim();
  if (/web[-_ ]|nano-banana|leonardo-gemini|leonardo-gpt-image/i.test(raw)) {
    throw new Error("COMMERCIAL_MODEL_MUST_BE_OFFICIAL: web-account aliases are internal only");
  }
  const qualified = raw.match(/^(openai|google|gemini|vertex|leonardo)[:/](.+)$/i);
  if (qualified) {
    const prefix = qualified[1]!.toLowerCase();
    const provider: OfficialProvider = prefix === "openai" ? "openai" : prefix === "leonardo" ? "leonardo" : "google";
    return { provider, model: qualified[2]!, publicModel: raw };
  }
  if (/^(gpt-|o\d|chatgpt-)/i.test(raw)) return { provider: "openai", model: raw, publicModel: raw };
  if (/^(gemini-|imagen-)/i.test(raw)) return { provider: "google", model: raw, publicModel: raw };
  throw new Error("COMMERCIAL_MODEL_MUST_BE_OFFICIAL: use openai:<model>, google:<model>, or leonardo:<model-id>");
}

function textFromOpenAi(body: Record<string, unknown>) {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = record(record(choices[0]).message);
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => String(record(part).text || "")).filter(Boolean).join("");
  }
  return "";
}

function googleContents(messages: { role?: string; content?: unknown }[]) {
  return messages.map((message) => {
    const role = message.role === "assistant" ? "model" : "user";
    if (typeof message.content === "string") return { role, parts: [{ text: message.content }] };
    const parts: Record<string, unknown>[] = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const item = record(part);
        if (item.type === "text" && typeof item.text === "string") {
          parts.push({ text: item.text });
          continue;
        }
        const image = record(item.image_url);
        const url = typeof item.image_url === "string" ? item.image_url : typeof image.url === "string" ? image.url : "";
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      }
    }
    return { role, parts };
  }).filter((content) => content.parts.length > 0);
}

export async function officialChat(
  input: {
    resolved: ResolvedOfficialModel;
    messages: { role?: string; content?: unknown }[];
    maxCompletionTokens?: number;
    temperature?: number;
    tenantId: string;
  },
  opts: { fetcher?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number; db?: Pick<Sql, "query"> } = {},
): Promise<OfficialChatResult> {
  const fetcher = opts.fetcher || fetch;
  const env = opts.env || await effectiveCommercialEnv(process.env, opts.db);
  const timeout = opts.timeoutMs || 180_000;
  if (input.resolved.provider === "leonardo") {
    return { ok: false, provider: "leonardo", status: 400, error: "Leonardo official API does not provide chat completions", code: "CAPABILITY_NOT_SUPPORTED" };
  }
  if (input.resolved.provider === "openai") {
    const key = env.OPENAI_API_KEY || "";
    if (!key) return { ok: false, provider: "openai", status: 503, error: "OPENAI_API_KEY is not configured", code: "OFFICIAL_CREDENTIAL_MISSING" };
    try {
      const response = await fetcher("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({
          model: input.resolved.model,
          messages: input.messages,
          stream: false,
          store: false,
          max_completion_tokens: Math.max(1, Math.min(128_000, Math.floor(input.maxCompletionTokens || 4096))),
          ...(Number.isFinite(input.temperature) ? { temperature: input.temperature } : {}),
          user: shaTenant(input.tenantId),
        }),
      });
      const body = record(await response.json().catch(() => ({})));
      if (!response.ok) return { ok: false, provider: "openai", status: response.status, error: errorMessage(body, `OpenAI HTTP ${response.status}`), code: String(record(body.error).code || "OFFICIAL_UPSTREAM_ERROR") };
      const usage = record(body.usage);
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const text = textFromOpenAi(body);
      if (!text) return { ok: false, provider: "openai", status: 502, error: "OpenAI returned no assistant text", code: "OFFICIAL_EMPTY_RESULT" };
      return {
        ok: true, provider: "openai", model: String(body.model || input.resolved.model), id: String(body.id || crypto.randomUUID()), text,
        promptTokens: Number(usage.prompt_tokens || 0), completionTokens: Number(usage.completion_tokens || 0),
        finishReason: String(record(choices[0]).finish_reason || "stop"), raw: body,
      };
    } catch (error) {
      return { ok: false, provider: "openai", status: 504, error: error instanceof Error ? error.message : "OpenAI request failed", code: "OFFICIAL_TIMEOUT" };
    }
  }

  const key = env.GEMINI_API_KEY || "";
  if (!key) return { ok: false, provider: "google", status: 503, error: "GEMINI_API_KEY is not configured", code: "OFFICIAL_CREDENTIAL_MISSING" };
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.resolved.model)}:generateContent`;
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({
        contents: googleContents(input.messages),
        generationConfig: {
          maxOutputTokens: Math.max(1, Math.min(65_536, Math.floor(input.maxCompletionTokens || 4096))),
          ...(Number.isFinite(input.temperature) ? { temperature: input.temperature } : {}),
        },
      }),
    });
    const body = record(await response.json().catch(() => ({})));
    if (!response.ok) return { ok: false, provider: "google", status: response.status, error: errorMessage(body, `Gemini HTTP ${response.status}`), code: String(record(body.error).status || "OFFICIAL_UPSTREAM_ERROR") };
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const content = record(record(candidates[0]).content);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const text = parts.map((part) => String(record(part).text || "")).filter(Boolean).join("");
    const usage = record(body.usageMetadata);
    if (!text) return { ok: false, provider: "google", status: 502, error: "Gemini returned no text candidate", code: "OFFICIAL_EMPTY_RESULT" };
    return {
      ok: true, provider: "google", model: String(body.modelVersion || input.resolved.model), id: String(body.responseId || crypto.randomUUID()), text,
      promptTokens: Number(usage.promptTokenCount || 0), completionTokens: Number(usage.candidatesTokenCount || 0),
      finishReason: String(record(candidates[0]).finishReason || "STOP"), raw: body,
    };
  } catch (error) {
    return { ok: false, provider: "google", status: 504, error: error instanceof Error ? error.message : "Gemini request failed", code: "OFFICIAL_TIMEOUT" };
  }
}

function shaTenant(tenantId: string) {
  // Stable non-PII end-user identifier for upstream abuse monitoring.
  let hash = 2166136261;
  for (const char of tenantId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `tenant_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function collectInlineImages(body: Record<string, unknown>) {
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  return candidates.flatMap((candidate) => {
    const parts = Array.isArray(record(record(candidate).content).parts) ? record(record(candidate).content).parts as unknown[] : [];
    return parts.flatMap((part) => {
      const inline = record(record(part).inlineData || record(part).inline_data);
      return typeof inline.data === "string" ? [{ b64_json: inline.data }] : [];
    });
  });
}

export async function officialImage(
  input: {
    resolved: ResolvedOfficialModel;
    prompt: string;
    n: number;
    size?: string;
    quality?: string;
    tenantId: string;
  },
  opts: { fetcher?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number; db?: Pick<Sql, "query"> } = {},
): Promise<OfficialImageResult> {
  const fetcher = opts.fetcher || fetch;
  const env = opts.env || await effectiveCommercialEnv(process.env, opts.db);
  const timeout = opts.timeoutMs || 300_000;
  if (input.resolved.provider === "openai") {
    const key = env.OPENAI_API_KEY || "";
    if (!key) return { ok: false, provider: "openai", status: 503, error: "OPENAI_API_KEY is not configured", code: "OFFICIAL_CREDENTIAL_MISSING" };
    try {
      const response = await fetcher("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({
          model: input.resolved.model, prompt: input.prompt, n: input.n,
          ...(input.size ? { size: input.size } : {}), ...(input.quality ? { quality: input.quality.toLowerCase() } : {}),
          response_format: "b64_json", user: shaTenant(input.tenantId),
        }),
      });
      const body = record(await response.json().catch(() => ({})));
      if (!response.ok) return { ok: false, provider: "openai", status: response.status, error: errorMessage(body, `OpenAI image HTTP ${response.status}`), code: String(record(body.error).code || "OFFICIAL_UPSTREAM_ERROR") };
      const images = (Array.isArray(body.data) ? body.data : []).map((item) => {
        const row = record(item);
        return { url: typeof row.url === "string" ? row.url : undefined, b64_json: typeof row.b64_json === "string" ? row.b64_json : undefined, revised_prompt: typeof row.revised_prompt === "string" ? row.revised_prompt : undefined };
      }).filter((image) => image.url || image.b64_json);
      if (images.length !== input.n) return { ok: false, provider: "openai", status: 502, error: `OpenAI returned ${images.length}/${input.n} images`, code: "RESULT_COUNT_MISMATCH" };
      return { ok: true, provider: "openai", model: input.resolved.model, id: String(body.id || crypto.randomUUID()), images, promptTokens: 0, completionTokens: 0, raw: body };
    } catch (error) {
      return { ok: false, provider: "openai", status: 504, error: error instanceof Error ? error.message : "OpenAI image failed", code: "OFFICIAL_TIMEOUT" };
    }
  }

  if (input.resolved.provider === "google") {
    const key = env.GEMINI_API_KEY || "";
    if (!key) return { ok: false, provider: "google", status: 503, error: "GEMINI_API_KEY is not configured", code: "OFFICIAL_CREDENTIAL_MISSING" };
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.resolved.model)}:generateContent`;
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: input.prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"], candidateCount: input.n },
        }),
      });
      const body = record(await response.json().catch(() => ({})));
      if (!response.ok) return { ok: false, provider: "google", status: response.status, error: errorMessage(body, `Gemini image HTTP ${response.status}`), code: String(record(body.error).status || "OFFICIAL_UPSTREAM_ERROR") };
      const images = collectInlineImages(body);
      const usage = record(body.usageMetadata);
      if (images.length !== input.n) return { ok: false, provider: "google", status: 502, error: `Gemini returned ${images.length}/${input.n} images`, code: "RESULT_COUNT_MISMATCH" };
      return { ok: true, provider: "google", model: String(body.modelVersion || input.resolved.model), id: String(body.responseId || crypto.randomUUID()), images, promptTokens: Number(usage.promptTokenCount || 0), completionTokens: Number(usage.candidatesTokenCount || 0), raw: body };
    } catch (error) {
      return { ok: false, provider: "google", status: 504, error: error instanceof Error ? error.message : "Gemini image failed", code: "OFFICIAL_TIMEOUT" };
    }
  }

  return officialLeonardoImage(input, { fetcher, env, timeoutMs: timeout });
}

async function officialLeonardoImage(
  input: { resolved: ResolvedOfficialModel; prompt: string; n: number; size?: string; tenantId: string },
  opts: { fetcher: typeof fetch; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<OfficialImageResult> {
  const key = opts.env.LEONARDO_API_KEY || "";
  if (!key) return { ok: false, provider: "leonardo", status: 503, error: "LEONARDO_API_KEY is not configured", code: "OFFICIAL_CREDENTIAL_MISSING" };
  const modelMap = (() => {
    try { return JSON.parse(opts.env.LEONARDO_MODEL_MAP_JSON || "{}") as Record<string, string>; } catch { return {}; }
  })();
  const modelId = modelMap[input.resolved.model] || input.resolved.model;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(modelId)) {
    return { ok: false, provider: "leonardo", status: 400, error: "Leonardo commercial model must map to an official model UUID", code: "OFFICIAL_MODEL_MAPPING_REQUIRED" };
  }
  const [width, height] = (input.size || "1024x1024").split("x").map(Number);
  try {
    const created = await opts.fetcher("https://cloud.leonardo.ai/api/rest/v1/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, accept: "application/json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(Math.min(opts.timeoutMs, 30_000)),
      body: JSON.stringify({ modelId, prompt: input.prompt, num_images: input.n, width: width || 1024, height: height || 1024, public: false, alchemy: false }),
    });
    const createBody = record(await created.json().catch(() => ({})));
    if (!created.ok) return { ok: false, provider: "leonardo", status: created.status, error: errorMessage(createBody, `Leonardo HTTP ${created.status}`), code: "OFFICIAL_UPSTREAM_ERROR" };
    const job = record(createBody.sdGenerationJob || createBody.generation || createBody.data);
    const generationId = String(job.generationId || job.id || createBody.generationId || "");
    if (!generationId) return { ok: false, provider: "leonardo", status: 502, error: "Leonardo returned no generationId", code: "OFFICIAL_EMPTY_RESULT" };
    const deadline = Date.now() + opts.timeoutMs - 2_000;
    const pollMs = Math.max(10, Math.min(10_000, Number(opts.env.LEONARDO_POLL_MS || 1500)));
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const response = await opts.fetcher(`https://cloud.leonardo.ai/api/rest/v1/generations/${encodeURIComponent(generationId)}`, {
        headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      const body = record(await response.json().catch(() => ({})));
      if (!response.ok) return { ok: false, provider: "leonardo", status: response.status, error: errorMessage(body, `Leonardo poll HTTP ${response.status}`), code: "OFFICIAL_UPSTREAM_ERROR" };
      const generation = record(body.generations_by_pk || body.generation || body.data);
      const generated = Array.isArray(generation.generated_images) ? generation.generated_images : Array.isArray(generation.images) ? generation.images : [];
      const images = generated.map((image) => ({ url: String(record(image).url || "") })).filter((image) => image.url);
      if (images.length >= input.n) return { ok: true, provider: "leonardo", model: modelId, id: generationId, images: images.slice(0, input.n), promptTokens: 0, completionTokens: 0, raw: body };
      const status = String(generation.status || job.status || "").toUpperCase();
      if (["FAILED", "ERROR", "CANCELLED"].includes(status)) return { ok: false, provider: "leonardo", status: 502, error: `Leonardo generation ${status}`, code: "OFFICIAL_GENERATION_FAILED" };
    }
    return { ok: false, provider: "leonardo", status: 504, error: "Leonardo generation timeout", code: "OFFICIAL_TIMEOUT" };
  } catch (error) {
    return { ok: false, provider: "leonardo", status: 504, error: error instanceof Error ? error.message : "Leonardo request failed", code: "OFFICIAL_TIMEOUT" };
  }
}
