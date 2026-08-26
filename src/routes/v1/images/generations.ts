import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey, pickAccount, readControlPlane } from "@/lib/control-plane";
import { decide } from "@/lib/fault-matrix";
import { enqueueImage, getJob, liveWorkerOnline, waitJob } from "@/lib/job-queue";
import { defaultPrompt, parseImageRequest } from "@/lib/media";
import { completeRequest, createRelayRequest } from "@/lib/requests";
import { fallbackImage } from "@/lib/upstream";
import { appendUsage } from "@/lib/usage";
import { estimateTokens } from "@/lib/tokens";
import { uid } from "@/lib/utils";

const ALLOWED = new Set(["prompt", "model", "image", "image_url", "images"]);

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
      if (!["prompt", "model", "image", "image_url", "images", "mask"].includes(key)) {
        extra.push(key);
      }
    }
    return { prompt, model, images, extra };
  }
  const body = (await request.json()) as Record<string, unknown>;
  const parsed = parseImageRequest(body);
  const extra = Object.keys(body).filter((k) => !ALLOWED.has(k));
  if (body.mask) extra.push("mask");
  return { prompt: parsed.prompt, model: String(body.model || ""), images: parsed.images, extra };
}

export async function handleImage(request: Request, kind: "image" | "edit" = "image") {
  const started = Date.now();
  const auth = await assertApiKey(request, "image");
  if (!auth.ok) {
    return Response.json({ error: { message: auth.error } }, { status: auth.status, headers: cors() });
  }
  let parsed: { prompt: string; model: string; images: string[]; extra: string[] };
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
  if (kind === "edit" && !parsed.images.length) {
    return Response.json({ error: { message: "edits 需要至少一张参考图", type: "invalid_request_error" } }, { status: 400, headers: cors() });
  }
  const prompt = defaultPrompt("image", parsed.prompt, parsed.images);
  if (!prompt) {
    return Response.json({ error: { message: "缺少 prompt 或参考图" } }, { status: 400, headers: cors() });
  }
  const model = parsed.model || "gemini-image";
  const requestId = request.headers.get("x-request-id") || uid();
  const idem = request.headers.get("idempotency-key") || undefined;
  const created = await createRelayRequest({
    id: requestId,
    idempotencyKey: idem,
    keyId: auth.record.id,
    provider: "gemini",
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
      platform: "gemini",
      model,
      accountEmail: row.accountEmail || "",
      ok: row.ok,
      latencyMs: Date.now() - started,
      images: parsed.images.length,
      promptPreview: prompt.slice(0, 80),
      error: row.error,
      mode: row.mode,
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
    if (!plane.settings.allowPreviewFallback) {
      const error = "WORKER_DEAD: 没有在线的网页执行器";
      await completeRequest(reqId, { ok: false, finalError: error });
      await log({ ok: false, error });
      return Response.json({ error: { message: error } }, { status: 503, headers: cors() });
    }
    const account = await pickAccount("gemini");
    const fb = await fallbackImage(prompt, 90_000, parsed.images);
    if (!fb.ok) {
      await completeRequest(reqId, { ok: false, finalError: fb.error });
      await log({ ok: false, error: fb.error });
      return Response.json({ error: { message: fb.error } }, { status: 502, headers: cors() });
    }
    await completeRequest(reqId, { ok: true });
    await log({ ok: true, accountEmail: account?.email || "preview", mode: "preview" });
    return Response.json(imagePayload(fb.url, account?.email || "preview", uid(), parsed.images.length, "preview", reqId), {
      headers: cors(),
    });
  }
  const exclude: string[] = [];
  const maxRetry = plane.settings.maxRetry || 3;
  let last = "没有可调度的健康 Gemini 账号（需 Session + sticky）";
  for (let i = 0; i <= maxRetry; i++) {
    const account = await pickAccount("gemini", exclude);
    if (!account) break;
    const queued = await enqueueImage(prompt, model, 90_000, parsed.images, {
      idempotencyKey: idem,
      requestId: reqId,
      excludeAccountIds: exclude,
      kind: kind === "edit" ? "edit" : "image",
      selectorPackVersion: "gemini-v1",
    });
    if (!queued.ok) {
      last = queued.error;
      if (queued.error.includes("circuit OPEN")) break;
      exclude.push(account.id);
      continue;
    }
    const done = await waitJob(queued.job.id, queued.job.timeoutMs);
    const fresh = (await getJob(queued.job.id)) || done.job || queued.job;
    if (done.ok && done.url) {
      await completeRequest(reqId, { ok: true, finalAttemptId: fresh.attemptId });
      await log({
        ok: true,
        accountEmail: queued.job.accountEmail,
        mode: "live",
        jobId: queued.job.id,
        attemptId: fresh.attemptId,
        workerId: fresh.workerId,
        accountId: fresh.accountId || undefined,
        proxyId: fresh.proxyId,
      });
      return Response.json(
        imagePayload(done.url, queued.job.accountEmail, queued.job.id, parsed.images.length, "live", reqId, fresh),
        { headers: cors() },
      );
    }
    last = done.ok ? "未返回图片" : done.error;
    const decision = decide(last, fresh.fault);
    if (!decision.switch_account) break;
    exclude.push(account.id);
  }
  await completeRequest(reqId, { ok: false, finalError: last });
  await log({ ok: false, error: last });
  return Response.json({ error: { message: last } }, { status: 504, headers: cors() });
}

function imagePayload(
  url: string,
  accountEmail: string,
  jobId: string,
  imageCount: number,
  mode: string,
  requestId?: string,
  extra?: { attemptId?: string; workerId?: string; accountId?: string | null; proxyId?: string; traceId?: string },
) {
  return {
    created: Math.floor(Date.now() / 1000),
    data: [{ url }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    relay: {
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
    },
  };
}

export function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-api-key, idempotency-key, x-request-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
