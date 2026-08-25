import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey, pickAccount, readControlPlane } from "@/lib/control-plane";
import { enqueueImage, liveWorkerOnline, waitJob } from "@/lib/job-queue";
import { defaultPrompt, parseImageRequest } from "@/lib/media";
import { fallbackImage } from "@/lib/upstream";
import { appendUsage } from "@/lib/usage";
import { uid } from "@/lib/utils";

export const Route = createFileRoute("/v1/images/generations")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors() }),
      POST: async ({ request }) => handleImage(request),
    },
  },
});

export async function handleImage(request: Request) {
  const started = Date.now();
  const auth = await assertApiKey(request, "image");
  if (!auth.ok) {
    return Response.json({ error: { message: auth.error } }, { status: auth.status, headers: cors() });
  }
  let body: { prompt?: string; image?: unknown; image_url?: unknown; images?: unknown; model?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: { message: "JSON 无效" } }, { status: 400, headers: cors() });
  }
  const parsed = parseImageRequest(body);
  const prompt = defaultPrompt("image", parsed.prompt, parsed.images);
  if (!prompt) {
    return Response.json({ error: { message: "缺少 prompt 或参考图" } }, { status: 400, headers: cors() });
  }
  const model = body.model || "gemini-image";
  const account = await pickAccount("gemini");
  const live = await liveWorkerOnline();
  const plane = await readControlPlane();
  const log = (row: { ok: boolean; accountEmail?: string; error?: string; mode?: string; jobId?: string }) =>
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
    });

  if (!live) {
    if (!plane.settings.allowPreviewFallback) {
      const error = "没有在线的网页执行器。请运行本机 Worker 后才能出图原文。";
      await log({ ok: false, error });
      return Response.json({ error: { message: error } }, { status: 503, headers: cors() });
    }
    const fb = await fallbackImage(prompt, 90_000, parsed.images);
    if (!fb.ok) {
      await log({ ok: false, error: fb.error });
      return Response.json({ error: { message: fb.error } }, { status: 502, headers: cors() });
    }
    await log({ ok: true, accountEmail: account?.email || "preview", mode: "preview" });
    return Response.json(imagePayload(fb.url, account?.email || "preview", uid(), parsed.images.length, "preview"), {
      headers: cors(),
    });
  }
  if (!account) {
    const error = "没有可调度的健康 Gemini 账号（需 Session + sticky）";
    await log({ ok: false, error });
    return Response.json({ error: { message: error } }, { status: 503, headers: cors() });
  }
  const queued = await enqueueImage(prompt, model, 90_000, parsed.images);
  if (!queued.ok) {
    await log({ ok: false, error: queued.error });
    return Response.json({ error: { message: queued.error } }, { status: 503, headers: cors() });
  }
  const done = await waitJob(queued.job.id, queued.job.timeoutMs);
  if (!done.ok || !done.url) {
    const error = done.ok ? "未返回图片" : done.error;
    await log({ ok: false, accountEmail: queued.job.accountEmail, error, jobId: queued.job.id });
    return Response.json({ error: { message: error } }, { status: 504, headers: cors() });
  }
  await log({
    ok: true,
    accountEmail: queued.job.accountEmail,
    mode: "live",
    jobId: queued.job.id,
  });
  return Response.json(
    imagePayload(done.url, queued.job.accountEmail, queued.job.id, parsed.images.length, "live"),
    { headers: cors() },
  );
}

function imagePayload(url: string, accountEmail: string, jobId: string, imageCount: number, mode: string) {
  return {
    created: Math.floor(Date.now() / 1000),
    data: [{ url }],
    relay: { accountEmail, jobId, mode, images: imageCount },
  };
}

export function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-api-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
