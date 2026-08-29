import type { CommercialApiKey } from "./commercial-types";
import { officialChat, officialImage, resolveOfficialModel } from "./official-providers";
import { acquireCommercialConcurrency, recordTenantApiKeyUse, releaseCommercialConcurrency } from "./saas-api-keys";
import { checkpointUsageProviderResult, decodeUsageProviderResult, releaseUsageReservation, reserveUsage, settleUsage } from "./saas-billing";
import { estimateTokens } from "./tokens";
import { detectMagicMime } from "./provider/image-result-validator";
import { persistImageBytes } from "./media-store";

function errorResponse(error: string) {
  if (/PRICE_NOT_CONFIGURED|MODEL_MAPPING_REQUIRED|MUST_BE_OFFICIAL/.test(error)) return { status: 400, code: "commercial_configuration_error" };
  if (/INSUFFICIENT_BALANCE|BUDGET/.test(error)) return { status: 402, code: "insufficient_balance" };
  if (/TENANT_SUSPENDED/.test(error)) return { status: 403, code: "tenant_suspended" };
  return { status: 503, code: "commercial_gateway_error" };
}

function replayFailure(provider: "openai" | "google" | "leonardo", status: string) {
  return {
    ok: false as const,
    provider,
    status: status === "released" ? 409 : 425,
    error: status === "released" ? "IDEMPOTENT_REQUEST_PREVIOUSLY_FAILED" : "IDEMPOTENT_REQUEST_IN_PROGRESS",
    code: status === "released" ? "IDEMPOTENT_REQUEST_PREVIOUSLY_FAILED" : "IDEMPOTENT_REQUEST_IN_PROGRESS",
  };
}

async function stableOfficialImages(images: { url?: string; b64_json?: string; revised_prompt?: string }[]) {
  const stable: { url: string; revised_prompt?: string }[] = [];
  for (const image of images) {
    let buf: Buffer;
    if (image.b64_json) {
      buf = Buffer.from(image.b64_json, "base64");
    } else if (image.url?.startsWith("https://")) {
      const response = await fetch(image.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`OFFICIAL_IMAGE_DOWNLOAD_FAILED: ${response.status}`);
      buf = Buffer.from(await response.arrayBuffer());
    } else throw new Error("OFFICIAL_IMAGE_RESULT_INVALID");
    if (buf.length < 100 || buf.length > 30 * 1024 * 1024) throw new Error("OFFICIAL_IMAGE_SIZE_INVALID");
    const mime = detectMagicMime(buf);
    if (!mime) throw new Error("OFFICIAL_IMAGE_MAGIC_INVALID");
    const stored = await persistImageBytes(buf, mime);
    stable.push({ url: stored.url, revised_prompt: image.revised_prompt });
  }
  return stable;
}

export async function commercialChatCompletion(input: {
  key: CommercialApiKey;
  requestId: string;
  messages: { role?: string; content?: unknown }[];
  model: string;
  maxCompletionTokens?: number;
  temperature?: number;
}) {
  const slot = await acquireCommercialConcurrency(input.key);
  if (!slot.ok) return { ok: false as const, provider: "openai" as const, status: 429, error: "RATE_LIMITED: concurrency", code: "RATE_LIMITED" };
  try {
    return await commercialChatCompletionRun(input);
  } finally {
    await releaseCommercialConcurrency(slot.semaphoreKey);
  }
}

async function commercialChatCompletionRun(input: {
  key: CommercialApiKey;
  requestId: string;
  messages: { role?: string; content?: unknown }[];
  model: string;
  maxCompletionTokens?: number;
  temperature?: number;
}) {
  try {
    const resolved = resolveOfficialModel(input.model);
    const estimatedPrompt = estimateTokens(JSON.stringify(input.messages));
    const reservation = await reserveUsage({
      tenantId: input.key.tenantId,
      apiKeyId: input.key.id,
      requestId: input.requestId,
      provider: resolved.provider,
      model: resolved.model,
      capability: "chat",
      estimatedPromptTokens: estimatedPrompt,
      estimatedCompletionTokens: input.maxCompletionTokens || 4096,
    });
    if (reservation.replay) {
      const saved = decodeUsageProviderResult(reservation.providerResultCiphertext);
      if (!saved || saved.kind !== "chat") return replayFailure(resolved.provider, reservation.status);
      const recovered = saved as {
        provider: "openai" | "google";
        model: string;
        id: string;
        text: string;
        promptTokens: number;
        completionTokens: number;
        finishReason: string;
        raw?: Record<string, unknown>;
      };
      const settlement = reservation.status === "settled"
        ? { chargedMinor: reservation.chargedMinor }
        : await settleUsage(reservation.chargeId, { promptTokens: recovered.promptTokens, completionTokens: recovered.completionTokens });
      return { ok: true as const, ...recovered, raw: recovered.raw || {}, chargeId: reservation.chargeId, chargedMinor: settlement.chargedMinor };
    }
    const result = await officialChat({
      resolved,
      messages: input.messages,
      maxCompletionTokens: input.maxCompletionTokens,
      temperature: input.temperature,
      tenantId: input.key.tenantId,
    });
    if (!result.ok) {
      await releaseUsageReservation(reservation.chargeId, `${result.code}: ${result.error}`);
      return result;
    }
    try {
      await checkpointUsageProviderResult(reservation.chargeId, {
        kind: "chat",
        provider: result.provider,
        model: result.model,
        id: result.id,
        text: result.text,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        finishReason: result.finishReason,
      });
      const settlement = await settleUsage(reservation.chargeId, {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      });
      await recordTenantApiKeyUse(input.key.id);
      return { ...result, chargeId: reservation.chargeId, chargedMinor: settlement.chargedMinor } as const;
    } catch (error) {
      return {
        ok: false as const,
        provider: resolved.provider,
        status: 503,
        error: `BILLING_SETTLEMENT_FAILED: ${error instanceof Error ? error.message : "unknown"}`,
        code: "BILLING_SETTLEMENT_FAILED",
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "COMMERCIAL_GATEWAY_FAILED";
    const mapped = errorResponse(message);
    return { ok: false as const, provider: "openai" as const, status: mapped.status, error: message, code: mapped.code };
  }
}

export async function commercialImageGeneration(input: {
  key: CommercialApiKey;
  requestId: string;
  prompt: string;
  model: string;
  n: number;
  size?: string;
  quality?: string;
}) {
  const slot = await acquireCommercialConcurrency(input.key, 15 * 60_000);
  if (!slot.ok) return { ok: false as const, provider: "openai" as const, status: 429, error: "RATE_LIMITED: concurrency", code: "RATE_LIMITED" };
  try {
    return await commercialImageGenerationRun(input);
  } finally {
    await releaseCommercialConcurrency(slot.semaphoreKey);
  }
}

async function commercialImageGenerationRun(input: {
  key: CommercialApiKey;
  requestId: string;
  prompt: string;
  model: string;
  n: number;
  size?: string;
  quality?: string;
}) {
  try {
    const resolved = resolveOfficialModel(input.model);
    const estimatedPrompt = estimateTokens(input.prompt);
    const reservation = await reserveUsage({
      tenantId: input.key.tenantId,
      apiKeyId: input.key.id,
      requestId: input.requestId,
      provider: resolved.provider,
      model: resolved.model,
      capability: "image",
      estimatedPromptTokens: estimatedPrompt,
      images: input.n,
    });
    if (reservation.replay) {
      const saved = decodeUsageProviderResult(reservation.providerResultCiphertext);
      if (!saved || saved.kind !== "image") return replayFailure(resolved.provider, reservation.status);
      const recovered = saved as {
        provider: "openai" | "google" | "leonardo";
        model: string;
        id: string;
        images: { url: string; revised_prompt?: string }[];
        promptTokens: number;
        completionTokens: number;
        raw?: Record<string, unknown>;
      };
      const settlement = reservation.status === "settled"
        ? { chargedMinor: reservation.chargedMinor }
        : await settleUsage(reservation.chargeId, { promptTokens: recovered.promptTokens, completionTokens: recovered.completionTokens, images: recovered.images.length });
      return { ok: true as const, ...recovered, raw: recovered.raw || {}, chargeId: reservation.chargeId, chargedMinor: settlement.chargedMinor };
    }
    const result = await officialImage({
      resolved,
      prompt: input.prompt,
      n: input.n,
      size: input.size,
      quality: input.quality,
      tenantId: input.key.tenantId,
    });
    if (!result.ok) {
      await releaseUsageReservation(reservation.chargeId, `${result.code}: ${result.error}`);
      return result;
    }
    try {
      const images = await stableOfficialImages(result.images);
      await checkpointUsageProviderResult(reservation.chargeId, {
        kind: "image",
        provider: result.provider,
        model: result.model,
        id: result.id,
        images,
        promptTokens: result.promptTokens || estimatedPrompt,
        completionTokens: result.completionTokens,
      });
      const settlement = await settleUsage(reservation.chargeId, {
        promptTokens: result.promptTokens || estimatedPrompt,
        completionTokens: result.completionTokens,
        images: images.length,
      });
      await recordTenantApiKeyUse(input.key.id);
      return { ...result, images, chargeId: reservation.chargeId, chargedMinor: settlement.chargedMinor } as const;
    } catch (error) {
      return {
        ok: false as const,
        provider: resolved.provider,
        status: 503,
        error: `BILLING_SETTLEMENT_FAILED: ${error instanceof Error ? error.message : "unknown"}`,
        code: "BILLING_SETTLEMENT_FAILED",
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "COMMERCIAL_GATEWAY_FAILED";
    const mapped = errorResponse(message);
    return { ok: false as const, provider: "openai" as const, status: mapped.status, error: message, code: mapped.code };
  }
}

export function openAiCompatibleCommercialChat(result: Extract<Awaited<ReturnType<typeof commercialChatCompletion>>, { ok: true }>, publicModel: string) {
  return {
    id: result.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: publicModel,
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: result.finishReason }],
    usage: { prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens, total_tokens: result.promptTokens + result.completionTokens },
    relay: { backend_mode: "official_api", provider: result.provider, charge_id: result.chargeId, charged_minor: result.chargedMinor },
  };
}

export function openAiCompatibleCommercialImages(result: Extract<Awaited<ReturnType<typeof commercialImageGeneration>>, { ok: true }>) {
  return {
    created: Math.floor(Date.now() / 1000),
    data: result.images,
    relay: { backend_mode: "official_api", provider: result.provider, charge_id: result.chargeId, charged_minor: result.chargedMinor },
  };
}
