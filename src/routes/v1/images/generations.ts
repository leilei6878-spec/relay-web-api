import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey, pickAccount, readControlPlane } from "@/lib/control-plane";
import { poolUnavailableMessage } from "@/lib/eligibility";
import { decideWithSafety } from "@/lib/fault-matrix";
import { enqueueImage, getJob, liveWorkerOnline, waitJob } from "@/lib/job-queue";
import { defaultPrompt, MAX_IMAGES_LEONARDO, parseImageRequest } from "@/lib/media";
import { completeRequest, createRelayRequest } from "@/lib/requests";
import { fallbackImage } from "@/lib/upstream";
import { appendUsage } from "@/lib/usage";
import { estimateTokens } from "@/lib/tokens";
import { publicRelayMeta } from "@/lib/public-relay-meta";
import { LEONARDO_API_WAIT_MS, LEONARDO_JOB_TIMEOUT_MS } from "@/lib/image-timeout";
import { uid } from "@/lib/utils";
import { commercialImageGeneration, openAiCompatibleCommercialImages } from "@/lib/commercial-gateway";
import { enforceCommercialKeyLimits } from "@/lib/saas-api-keys";
import type { CommercialApiKey } from "@/lib/commercial-types";
import { resolveOfficialModel } from "@/lib/official-providers";
import { collectSizeInput, resolveImageSpec } from "@/lib/provider/image-size";
import { getAdapter } from "@/lib/provider";
import { ingestReferenceImages } from "@/lib/reference-input";
import {
  defaultResponseFormat,
  IMAGE_OFFICIAL_PARAMS,
  isLeonardoModel,
  mapLogicalModel,
  validateLeonardoParams,
} from "@/lib/provider/leonardo-models";

const ALLOWED = new Set<string>(IMAGE_OFFICIAL_PARAMS);

export const Route = createFileRoute("/v1/images/generations")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors() }),
      POST: async ({ request }) => handleImage(request, "image"),
    },
  },
});

async function parseBody(request: Request) {
  const ctype = request.headers.get("content-type") || "";
  if (ctype.includes("multipart/form-data")) {
    const form = await request.formData();
    const prompt = String(form.get("prompt") || "");
    const model = String(form.get("model") || "");
    const images: string[] = [];
    const extra: string[] = [];
    if (form.get("mask")) extra.push("mask");
    const addFile = async (item: FormDataEntryValue | null) => {
      if (!item) return;
      if (typeof item === "string" && item) images.push(item);
      else if (typeof item === "object" && "arrayBuffer" in item) {
        const file = item as File;
        const buf = Buffer.from(await file.arrayBuffer());
        const mime = file.type || "image/png";
        images.push(`data:${mime};base64,${buf.toString("base64")}`);
      }
    };
    for (const key of ["image", "image_url"]) await addFile(form.get(key));
    for (const item of form.getAll("images")) await addFile(item);
    for (const [key] of form.entries()) {
      if (!ALLOWED.has(key) && key !== "mask") extra.push(key);
    }
    return {
      prompt,
      model,
      images,
      extra,
      n: Number(form.get("n") || 1),
      size: String(form.get("size") || "") || undefined,
      quality: String(form.get("quality") || "") || undefined,
      width: form.get("width") ? Number(form.get("width")) : undefined,
      height: form.get("height") ? Number(form.get("height")) : undefined,
      aspectRatio: String(form.get("aspect_ratio") || form.get("aspectRatio") || "") || undefined,
      imageSize: String(form.get("image_size") || form.get("imageSize") || "") || undefined,
      responseFormat: String(form.get("response_format") || "") || undefined,
      imageOverflow: images.length > (isLeonardoModel(model) ? MAX_IMAGES_LEONARDO : 4),
      imageInvalid: images.some(
        (url) => !url.startsWith("data:image") && !url.startsWith("http://") && !url.startsWith("https://"),
      ),
    };
  }
  const body = (await request.json()) as Record<string, unknown>;
  const parsed = parseImageRequest(body, {
    maxImages: isLeonardoModel(String(body.model || "")) ? MAX_IMAGES_LEONARDO : 4,
  });
  const extra = Object.keys(body).filter((k) => !ALLOWED.has(k));
  if (body.mask) extra.push("mask");
  const sizeFields = collectSizeInput(body, String(body.model || ""));
  return {
    prompt: parsed.prompt,
    model: String(body.model || ""),
    images: parsed.images,
    extra,
    n: typeof body.n === "number" ? body.n : Number(body.n || 1),
    size: sizeFields.size,
    quality: typeof body.quality === "string" ? body.quality : undefined,
    width: sizeFields.width,
    height: sizeFields.height,
    aspectRatio: sizeFields.aspectRatio,
    imageSize: sizeFields.imageSize,
    responseFormat: typeof body.response_format === "string" ? body.response_format : undefined,
    imageOverflow: parsed.imageOverflow,
    imageInvalid: parsed.imageInvalid,
  };
}

function dataUrlB64(url: string) {
  const m = url.match(/^data:[^;]+;base64,(.+)$/);
  return m?.[1];
}

export async function toB64(url: string) {
  const fromData = dataUrlB64(url);
  if (fromData) return fromData;
  const media = url.match(/\/api\/media\/([^/?#]+)/);
  if (media) {
    try {
      const { getMediaStore } = await import("@/lib/media-store");
      const got = await getMediaStore().get(media[1]);
      if (got) return got.buf.toString("base64");
    } catch {
      /* fall through */
    }
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  } catch {
    return undefined;
  }
}

export async function handleImage(request: Request, kind: "image" | "edit" = "image") {
  const started = Date.now();
  const auth = await assertApiKey(request, "image");
  if (!auth.ok) {
    return Response.json({ error: { message: auth.error } }, { status: auth.status, headers: cors() });
  }
  let parsed: Awaited<ReturnType<typeof parseBody>>;
  try {
    parsed = await parseBody(request);
  } catch {
    return Response.json({ error: { message: "JSON 无效" } }, { status: 400, headers: cors() });
  }
  if (parsed.extra.length) {
    const mask = parsed.extra.includes("mask");
    return Response.json(
      {
        error: {
          message: mask
            ? "unsupported parameter: mask"
            : `unsupported parameter: ${parsed.extra.join(", ")}`,
          type: "invalid_request_error",
          param: mask ? "mask" : parsed.extra[0],
        },
      },
      { status: 400, headers: cors() },
    );
  }
  if (parsed.imageOverflow) {
    const max = isLeonardoModel(parsed.model || "") ? MAX_IMAGES_LEONARDO : 4;
    return Response.json(
      { error: { message: `unsupported parameter: images max ${max}`, type: "invalid_request_error", param: "images" } },
      { status: 400, headers: cors() },
    );
  }
  if (parsed.imageInvalid) {
    return Response.json(
      { error: { message: "unsupported parameter: invalid image reference", type: "invalid_request_error", param: "images" } },
      { status: 400, headers: cors() },
    );
  }
  if (kind === "edit" && !parsed.images.length) {
    return Response.json({ error: { message: "edits 需要至少一张参考图", type: "invalid_request_error" } }, { status: 400, headers: cors() });
  }
  const prompt = defaultPrompt("image", parsed.prompt, parsed.images);
  if (!prompt) {
    return Response.json({ error: { message: "缺少 prompt 或参考图" } }, { status: 400, headers: cors() });
  }
  const model = parsed.model || "gemini-2.5-flash-image";
  if (auth.commercial) {
    if (kind === "edit" || parsed.images.length) {
      return Response.json(
        { error: { message: "Commercial image editing is disabled until official provider-specific upload flows are configured", type: "unsupported_parameter", param: "images" } },
        { status: 400, headers: cors() },
      );
    }
    let resolved;
    try {
      resolved = resolveOfficialModel(model);
    } catch (error) {
      return Response.json({ error: { message: error instanceof Error ? error.message : "COMMERCIAL_MODEL_MUST_BE_OFFICIAL" } }, { status: 400, headers: cors() });
    }
    const commercialKey = auth.record as CommercialApiKey;
    const limits = await enforceCommercialKeyLimits(commercialKey, "image", model);
    if (!limits.ok) {
      return Response.json({ error: { message: limits.error, type: "rate_limit_error" } }, { status: limits.status, headers: { ...cors(), ...(limits.retryAfter ? { "Retry-After": String(limits.retryAfter) } : {}) } });
    }
    const n = Math.max(1, Math.min(resolved.provider === "leonardo" ? 8 : 4, Math.floor(parsed.n || 1)));
    const requestId = request.headers.get("x-request-id") || uid();
    const result = await commercialImageGeneration({
      key: commercialKey,
      requestId,
      prompt,
      model,
      n,
      size: parsed.size,
      quality: parsed.quality,
    });
    if (!result.ok) {
      return Response.json({ error: { message: result.error, type: result.code } }, { status: result.status, headers: cors() });
    }
    return Response.json(openAiCompatibleCommercialImages(result), { headers: cors() });
  }
  const platform = isLeonardoModel(model) ? "leonardo" : "gemini";
  let n = 1;
  let size = "1024x1024";
  let quality = "MEDIUM";
  let aspect = "1:1";
  let tier: "Small" | "Medium" | "Large" = "Small";
  if (platform === "leonardo") {
    const mapped = mapLogicalModel(model);
    const gate = validateLeonardoParams({
      n: parsed.n,
      size: parsed.size,
      quality: parsed.quality,
      images: parsed.images,
      logical: mapped.logical,
      width: parsed.width,
      height: parsed.height,
      aspectRatio: parsed.aspectRatio,
      imageSize: parsed.imageSize,
      model,
    });
    if (!gate.ok) {
      return Response.json({ error: { message: gate.error, type: "invalid_request_error" } }, { status: 400, headers: cors() });
    }
    n = gate.n;
    size = gate.size;
    quality = gate.quality;
    aspect = gate.aspect;
    tier = gate.tier;
  } else {
    const resolved = resolveImageSpec({
      model,
      size: parsed.size,
      width: parsed.width,
      height: parsed.height,
      aspectRatio: parsed.aspectRatio,
      imageSize: parsed.imageSize,
    });
    if (!resolved.ok) {
      return Response.json({ error: { message: resolved.error, type: "invalid_request_error" } }, { status: 400, headers: cors() });
    }
    size = resolved.spec.size;
    aspect = resolved.spec.aspect;
    tier = resolved.spec.tier;
    n = Math.max(1, parsed.n || 1);
  }
  const maxOut = getAdapter(platform).capabilities().maxOutputs || 1;
  if (n > maxOut) {
    return Response.json(
      {
        error: {
          message: `unsupported parameter: n max ${maxOut} for ${platform} web_account`,
          type: "invalid_request_error",
          param: "n",
          code: "RESULT_COUNT_MISMATCH",
        },
      },
      { status: 400, headers: cors() },
    );
  }
  const format = defaultResponseFormat(model, parsed.responseFormat);
  const frozen = await ingestReferenceImages(parsed.images, new URL(request.url).origin);
  if (!frozen.ok) {
    return Response.json(
      { error: { message: frozen.error, type: "invalid_request_error", param: "images" } },
      { status: 400, headers: cors() },
    );
  }
  const referenceUrls = frozen.assets.map((asset) => asset.url);
  const requestId = request.headers.get("x-request-id") || uid();
  const idem = request.headers.get("idempotency-key") || undefined;
  const created = await createRelayRequest({
    id: requestId,
    idempotencyKey: idem,
    keyId: auth.record.id,
    provider: platform,
    model,
  });
  const reqId = created.request.id;
  const live = await liveWorkerOnline();
  const plane = await readControlPlane();
  const log = (row: {
    ok: boolean;
    accountEmail?: string;
    error?: string;
    mode?: string;
    jobId?: string;
    attemptId?: string;
    workerId?: string;
    accountId?: string;
    proxyId?: string;
  }) =>
    appendUsage({
      keyId: auth.record.id,
      keyName: auth.record.name,
      platform,
      model,
      accountEmail: row.accountEmail || "",
      ok: row.ok,
      latencyMs: Date.now() - started,
      images: parsed.images.length,
      promptPreview: prompt.slice(0, 80),
      error: row.error,
      mode: row.mode || (platform === "leonardo" ? "web_account" : row.mode),
      jobId: row.jobId,
      requestId: reqId,
      attemptId: row.attemptId,
      workerId: row.workerId,
      accountId: row.accountId,
      proxyId: row.proxyId,
      promptTokens: estimateTokens(prompt),
      completionTokens: 0,
    });

  if (!live) {
    if (!plane.settings.allowPreviewFallback || platform === "leonardo") {
      const error =
        platform === "leonardo"
          ? "WORKER_DEAD: Leonardo web_account 禁止预览假图"
          : "WORKER_DEAD: 没有在线的网页执行器";
      await completeRequest(reqId, { ok: false, finalError: error });
      await log({ ok: false, error });
      return Response.json({ error: { message: error } }, { status: 503, headers: cors() });
    }
    const account = await pickAccount(platform, [], { model });
    const fb = await fallbackImage(prompt, 90_000, referenceUrls);
    if (!fb.ok) {
      await completeRequest(reqId, { ok: false, finalError: fb.error });
      await log({ ok: false, error: fb.error });
      return Response.json({ error: { message: fb.error } }, { status: 502, headers: cors() });
    }
    await completeRequest(reqId, { ok: true });
    await log({ ok: true, accountEmail: account?.email || "preview", mode: "preview" });
    return Response.json(await imagePayload([fb.url], account?.email || "preview", uid(), parsed.images.length, "preview", reqId, undefined, format, size), {
      headers: cors(),
    });
  }
  const exclude: string[] = [];
  const maxRetry = plane.settings.maxRetry || 3;
  let last = poolUnavailableMessage(platform, plane.accounts, plane.proxies, plane.settings, {}, model);
  for (let i = 0; i <= maxRetry; i++) {
    const account = await pickAccount(platform, exclude, { model });
    if (!account) break;
    const queued = await enqueueImage(prompt, model, platform === "leonardo" ? LEONARDO_JOB_TIMEOUT_MS : 90_000, referenceUrls, {
      idempotencyKey: idem,
      keyId: auth.record.id,
      requestId: reqId,
      excludeAccountIds: exclude,
      kind: kind === "edit" || parsed.images.length ? "edit" : "image",
      selectorPackVersion: platform === "leonardo" ? "leonardo-image-v1" : "gemini-v1",
      n,
      size,
      quality,
      aspect,
      tier,
      referenceAssets: frozen.assets,
    });
    if (!queued.ok) {
      last = queued.error;
      if (queued.error.includes("circuit OPEN") || queued.error.includes("QUEUE_FULL")) break;
      exclude.push(account.id);
      continue;
    }
    const waitMs = Math.min(queued.job.timeoutMs, platform === "leonardo" ? LEONARDO_API_WAIT_MS : 80_000);
    const done = await waitJob(queued.job.id, waitMs, { graceMs: 10_000, cancelOnTimeout: false });
    const fresh = (await getJob(queued.job.id)) || done.job || queued.job;
    const urls = (fresh.urls && fresh.urls.length ? fresh.urls : done.url ? [done.url] : []).filter(Boolean);
    if (done.ok && urls.length === n) {
      await completeRequest(reqId, { ok: true, finalAttemptId: fresh.attemptId });
      await log({
        ok: true,
        accountEmail: queued.job.accountEmail,
        mode: platform === "leonardo" ? "web_account" : "live",
        jobId: queued.job.id,
        attemptId: fresh.attemptId,
        workerId: fresh.workerId,
        accountId: fresh.accountId || undefined,
        proxyId: fresh.proxyId,
      });
      return Response.json(
        await imagePayload(urls, queued.job.accountEmail, queued.job.id, parsed.images.length, platform === "leonardo" ? "web_account" : "live", reqId, fresh, format, size),
        { headers: cors() },
      );
    }
    last = done.ok ? (urls.length ? `RESULT_COUNT_MISMATCH: want ${n} got ${urls.length}` : "未返回图片") : done.error;
    const decision = decideWithSafety(last, fresh.fault, fresh.retrySafety, fresh.submissionState);
    if (!decision.switch_account) break;
    exclude.push(account.id);
  }
  await completeRequest(reqId, { ok: false, finalError: last });
  await log({ ok: false, error: last });
  const status = last.includes("QUEUE_FULL") ? 429 : 504;
  return Response.json(
    { error: { message: last } },
    { status, headers: status === 429 ? { ...cors(), "Retry-After": "5" } : cors() },
  );
}

async function imagePayload(
  urls: string[],
  accountEmail: string,
  jobId: string,
  imageCount: number,
  mode: string,
  requestId?: string,
  extra?: {
    attemptId?: string;
    workerId?: string;
    accountId?: string | null;
    proxyId?: string;
    traceId?: string;
    actualWidth?: number;
    actualHeight?: number;
    actualAspect?: string;
    requestedSize?: string;
    requestedTier?: string;
    actualTier?: string;
    size?: string;
  },
  format: "url" | "b64_json" = "url",
  size?: string,
) {
  const data = [];
  for (const url of urls) {
    const row: { url?: string; b64_json?: string; revised_prompt?: string } = {};
    if (format === "b64_json") {
      const b64 = await toB64(url);
      if (b64) row.b64_json = b64;
      else row.url = url;
    } else {
      row.url = url;
    }
    data.push(row);
  }
  return {
    created: Math.floor(Date.now() / 1000),
    data,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
    },
    relay: publicRelayMeta({
      accountEmail,
      jobId,
      mode,
      images: imageCount,
      requestId,
      attemptId: extra?.attemptId,
      workerId: extra?.workerId,
      accountId: extra?.accountId,
      proxyId: extra?.proxyId,
      traceId: extra?.traceId,
      backend_mode: mode === "web_account" ? "web_account" : undefined,
      size,
      requested_size: extra?.requestedSize || size,
      actual_width: extra?.actualWidth,
      actual_height: extra?.actualHeight,
      actual_aspect: extra?.actualAspect,
      requested_tier: extra?.requestedTier,
      actual_tier: extra?.actualTier,
    }),
  };
}

export function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-api-key, x-goog-api-key, idempotency-key, x-request-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
