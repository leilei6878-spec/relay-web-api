import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey, pickAccount, readControlPlane } from "@/lib/control-plane";
import { poolUnavailableMessage } from "@/lib/eligibility";
import { getCircuit } from "@/lib/circuit";
import { decideWithSafety } from "@/lib/fault-matrix";
import { enqueueChat, getJob, liveWorkerOnline, waitJob, cancelJob } from "@/lib/job-queue";
import { nextSseDelta, subscribeJob } from "@/lib/job-events";
import { parseMessageContent } from "@/lib/media";
import { prepareChatRequest } from "@/lib/provider/index";
import type { ChatTurn } from "@/lib/provider/types";
import { ingestReferenceImages, type ReferenceAsset } from "@/lib/reference-input";
import type { ApiKeyRecord } from "@/lib/api-keys";
import { completeRequest, createRelayRequest } from "@/lib/requests";
import { attachSseLifecycle, enqueueWithBackpressure, sseUsageChunk } from "@/lib/sse-runtime";
import { fallbackChat, openPreviewChatStream } from "@/lib/upstream";
import { appendUsage } from "@/lib/usage";
import { estimateTokens } from "@/lib/tokens";
import { uid } from "@/lib/utils";
import { bootProductionGuard } from "@/lib/production-guard";

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
  requestId?: string;
  traceId?: string;
  attemptId?: string;
  workerId?: string;
  accountId?: string;
  proxyId?: string;
  requestedModel?: string;
  actualModel?: string;
  actualModelLabel?: string;
  modelVerified?: boolean;
  requestedProfile?: string;
  actualProfile?: string;
  profileVerified?: boolean;
};
type ChatFail = { ok: false; status: number; error: string };

const ALLOWED = new Set(["messages", "model", "stream"]);

export const Route = createFileRoute("/v1/chat/completions")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors() }),
      POST: async ({ request }) => handleChat(request),
    },
  },
});

export async function handleChat(request: Request): Promise<Response> {
        try {
          bootProductionGuard();
        } catch (err) {
          return Response.json(
            { error: { message: err instanceof Error ? err.message : "fail-closed", type: "server_error" } },
            { status: 503, headers: cors() },
          );
        }
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
        const imageOverflow = (body.messages || []).some((message) => parseMessageContent(message.content).imageOverflow);
        const imageInvalid = (body.messages || []).some((message) => parseMessageContent(message.content).imageInvalid);
        if (imageInvalid) {
          return Response.json(
            { error: { message: "unsupported parameter: invalid chat image", type: "invalid_request_error" } },
            { status: 400, headers: cors() },
          );
        }
        if (imageOverflow) {
          return Response.json(
            { error: { message: "unsupported parameter: chat images max 4", type: "invalid_request_error" } },
            { status: 400, headers: cors() },
          );
        }
        const prepared = prepareChatRequest("chatgpt", {
          messages: body.messages,
          model: body.model || "chatgpt-web-auto",
          images: parsed.images,
        });
        const prompt = prepared.webPrompt;
        if (!prompt && !prepared.images.length) {
          return Response.json({ error: { message: "缺少 user 消息或图片" } }, { status: 400, headers: cors() });
        }
        if (!prepared.turns.some((t) => t.role === "user") && !prepared.images.length) {
          return Response.json({ error: { message: "缺少 user 消息" } }, { status: 400, headers: cors() });
        }
        const unsupported = Object.keys(body).filter((k) => !ALLOWED.has(k));
        if (unsupported.length) {
          return Response.json(
            { error: { message: `unsupported parameter: ${unsupported.join(", ")}`, type: "invalid_request_error" } },
            { status: 400, headers: cors() },
          );
        }
        const model = prepared.model;
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
        const started = Date.now();
        const idem = request.headers.get("idempotency-key") || undefined;
        const requestId = request.headers.get("x-request-id") || uid();
        if (body.stream) {
          return streamChat(prompt, model, frozenImages, auth.record, idem, requestId, request.signal, frozenTurns, prepared.selectorPackVersion, frozen.assets);
        }
        const result = await runChat(prompt, model, frozenImages, idem, requestId, auth.record.id, frozenTurns, prepared.selectorPackVersion, frozen.assets);
        await logUsage(auth.record, model, parsed, prompt, started, result);
        if (!result.ok) {
          return Response.json(
            { error: { message: result.error } },
            { status: result.status, headers: result.status === 429 ? { ...cors(), "Retry-After": "5" } : cors() },
          );
        }
        return Response.json(
          completion(result, parsed.images.length, estimateTokens(prompt), estimateTokens(result.text)),
          { headers: cors() },
        );
}

async function logUsage(
  key: ApiKeyRecord,
  model: string,
  parsed: { images: string[] },
  prompt: string,
  started: number,
  result: ChatOk | ChatFail,
) {
  await appendUsage({
    keyId: key.id,
    keyName: key.name,
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
    requestId: result.ok ? result.requestId : undefined,
    traceId: result.ok ? result.traceId : undefined,
    attemptId: result.ok ? result.attemptId : undefined,
    workerId: result.ok ? result.workerId : undefined,
    accountId: result.ok ? result.accountId : undefined,
    proxyId: result.ok ? result.proxyId : undefined,
    promptTokens: estimateTokens(prompt),
    completionTokens: result.ok ? estimateTokens(result.text) : 0,
  });
}

function chatJobTimeoutMs(model: string, images?: string[]) {
  if (/thinking|o1|o3/i.test(model || "")) return 180_000;
  if (images && images.length) return 90_000;
  return 45_000;
}

export async function runChat(
  prompt: string,
  model: string,
  images: string[] = [],
  idempotencyKey?: string,
  requestId?: string,
  keyId?: string,
  turns?: ChatTurn[],
  selectorPackVersion?: string,
  referenceAssets?: ReferenceAsset[],
): Promise<ChatOk | ChatFail> {
  const plane = await readControlPlane();
  const maxRetry = plane.settings.maxRetry || 3;
  const exclude: string[] = [];
  const live = await liveWorkerOnline();
  const traceId = uid();
  const created = await createRelayRequest({
    id: requestId,
    idempotencyKey,
    keyId,
    provider: "chatgpt",
    model,
  });
  const reqId = created.request.id;
  if (!live) {
    if (!plane.settings.allowPreviewFallback) {
      await completeRequest(reqId, { ok: false, finalError: "WORKER_DEAD: 没有在线的网页执行器" });
      return { ok: false, status: 503, error: "WORKER_DEAD: 没有在线的网页执行器" };
    }
    const account = await pickAccount("chatgpt");
    if (!account) {
      await completeRequest(reqId, { ok: false, finalError: "没有可调度的健康 ChatGPT 账号" });
      return { ok: false, status: 503, error: "没有可调度的健康 ChatGPT 账号" };
    }
    const fb = await fallbackChat(prompt, 60_000, images);
    if (!fb.ok) {
      await completeRequest(reqId, { ok: false, finalError: fb.error });
      return { ok: false, status: 502, error: fb.error };
    }
    await completeRequest(reqId, { ok: true });
    return {
      ok: true,
      id: reqId,
      model,
      text: fb.text,
      accountEmail: account.email,
      mode: "preview",
      requestId: reqId,
      traceId,
      accountId: account.id,
      proxyId: account.proxyId || undefined,
      requestedModel: model,
      actualModel: "unknown",
      actualModelLabel: "preview",
      modelVerified: false,
      requestedProfile: model === "chatgpt-web-fast" ? "fast" : model === "chatgpt-web-auto" ? "auto" : "exact",
      actualProfile: "unknown",
      profileVerified: false,
    };
  }
  const circuit = await getCircuit("chatgpt");
  if (circuit.state === "OPEN") {
    const canary = await pickAccount("chatgpt");
    if (!canary) {
      await completeRequest(reqId, { ok: false, finalError: "PROVIDER_UNAVAILABLE: circuit OPEN, no canary" });
      return { ok: false, status: 503, error: "PROVIDER_UNAVAILABLE: circuit OPEN, no canary" };
    }
  }
  let last: ChatFail = { ok: false, status: 503, error: "没有可调度账号" };
  for (let i = 0; i <= maxRetry; i++) {
    const account = await pickAccount("chatgpt", exclude);
    if (!account) {
      last = { ok: false, status: 503, error: poolUnavailableMessage("chatgpt", plane.accounts, plane.proxies, plane.settings) };
      break;
    }
    const queued = await enqueueChat(prompt, model, chatJobTimeoutMs(model, images), images, {
      idempotencyKey,
      keyId,
      requestId: reqId,
      traceId,
      excludeAccountIds: exclude,
      turns,
      selectorPackVersion,
      referenceAssets,
    });
    if (!queued.ok) {
      last = { ok: false, status: queued.error.includes("QUEUE_FULL") ? 429 : 503, error: queued.error };
      if (queued.error.includes("circuit OPEN") || queued.error.includes("QUEUE_FULL")) break;
      exclude.push(account.id);
      continue;
    }
    const done = await waitJob(queued.job.id, queued.job.timeoutMs);
    const fresh = (await getJob(queued.job.id)) || done.job || queued.job;
    if (done.ok && done.text && !done.text.startsWith("MOCK:")) {
      await completeRequest(reqId, { ok: true, finalAttemptId: fresh.attemptId });
      return {
        ok: true,
        id: queued.job.id,
        model: queued.job.model,
        text: done.text,
        accountEmail: queued.job.accountEmail,
        mode: "live",
        requestId: reqId,
        traceId: queued.job.traceId,
        attemptId: fresh.attemptId,
        workerId: fresh.workerId,
        accountId: fresh.accountId || undefined,
        proxyId: fresh.proxyId,
        requestedModel: fresh.requestedModel || queued.job.model,
        actualModel: fresh.actualModel || "unknown",
        actualModelLabel: fresh.actualModelLabel,
        modelVerified: fresh.modelVerified ?? false,
        requestedProfile: queued.job.model === "chatgpt-web-fast" ? "fast" : queued.job.model === "chatgpt-web-auto" ? "auto" : "exact",
        actualProfile: fresh.actualProfile || "unknown",
        profileVerified: fresh.profileVerified ?? false,
      };
    }
    const err = done.ok ? "执行器未返回模型原文" : done.error;
    const decision = decideWithSafety(err, fresh.fault, fresh.retrySafety, fresh.submissionState);
    last = { ok: false, status: 504, error: err };
    if (!decision.switch_account) {
      break;
    }
    exclude.push(account.id);
  }
  await completeRequest(reqId, { ok: false, finalError: last.error });
  return last;
}

export function streamChat(
  prompt: string,
  model: string,
  images: string[],
  key: ApiKeyRecord,
  idem?: string,
  requestId?: string,
  abortSignal?: AbortSignal,
  turns?: ChatTurn[],
  selectorPackVersion?: string,
  referenceAssets?: ReferenceAsset[],
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = async (obj: unknown) => {
        await enqueueWithBackpressure(controller, encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const finish = async () => {
        await enqueueWithBackpressure(controller, encoder.encode("data: [DONE]\n\n"));
      };
      const started = Date.now();
      const id = uid();
      let jobId: string | undefined;
      let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let wakeAbort: () => void = () => undefined;
      const aborted = new Promise<void>((resolve) => {
        wakeAbort = resolve;
      });
      const life = attachSseLifecycle({
        signal: abortSignal,
        timeoutMs: 210_000,
        onAbort: () => {
          wakeAbort();
          void upstreamReader?.cancel().catch(() => undefined);
        },
      });
      try {
        await send({
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: { role: "assistant" } }],
          relay: { phase: "start", images: images.length, requestId },
        });
        const plane = await readControlPlane();
        const live = await liveWorkerOnline();
        if (!live && !plane.settings.allowPreviewFallback) {
          await send({ error: { message: "WORKER_DEAD: 没有在线的网页执行器" }, relay: { phase: "error" } });
          await logUsage(key, model, { images }, prompt, started, { ok: false, status: 503, error: "WORKER_DEAD: 没有在线的网页执行器" });
          await finish();
          return;
        }
        if (!live && plane.settings.allowPreviewFallback) {
          const up = await openPreviewChatStream(prompt, images);
          if (up.ok) {
            const decoder = new TextDecoder();
            const reader = up.body.getReader();
            upstreamReader = reader;
            let buf = "";
            let text = "";
            while (true) {
              if (life.aborted()) break;
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
                    text += content;
                    await send({
                      id: `chatcmpl-${id}`,
                      object: "chat.completion.chunk",
                      model,
                      choices: [{ index: 0, delta: { content } }],
                      relay: { phase: "streaming", mode: "preview" },
                    });
                  }
                } catch {
                  /* keep-alive */
                }
              }
            }
            if (life.aborted()) {
              const why = `REQUEST_CANCELLED: ${life.reason()}`;
              await send({ error: { message: why }, relay: { phase: "error", logicalStatus: "cancelled", partialText: text } });
              await logUsage(key, model, { images }, prompt, started, { ok: false, status: 499, error: why });
              await finish();
              return;
            }
            await send({
              id: `chatcmpl-${id}`,
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              relay: {
                phase: "done",
                logicalStatus: "success",
                mode: "preview",
                requestedModel: model,
                actualModel: "unknown",
                actualModelLabel: "preview",
                modelVerified: false,
                requested_model: model,
                actual_model: "unknown",
                actual_model_label: "preview",
                model_verified: false,
                requestedProfile: model === "chatgpt-web-fast" ? "fast" : model === "chatgpt-web-auto" ? "auto" : "exact",
                actualProfile: "unknown",
                profileVerified: false,
                requested_profile: model === "chatgpt-web-fast" ? "fast" : model === "chatgpt-web-auto" ? "auto" : "exact",
                actual_profile: "unknown",
                profile_verified: false,
                finalText: text,
              },
            });
            await send(sseUsageChunk(model, id, estimateTokens(prompt), estimateTokens(text)));
            await logUsage(key, model, { images }, prompt, started, {
              ok: true,
              id,
              model,
              text,
              accountEmail: "preview",
              mode: "preview",
              requestId,
            });
            await finish();
            return;
          }
        }
        if (life.aborted()) {
          const why = `REQUEST_CANCELLED: ${life.reason()}`;
          await send({ error: { message: why }, relay: { phase: "error", logicalStatus: "cancelled" } });
          await logUsage(key, model, { images }, prompt, started, { ok: false, status: 499, error: why });
          await finish();
          return;
        }
        const queued = await enqueueChat(prompt, model, chatJobTimeoutMs(model, images), images, {
          idempotencyKey: idem,
          keyId: key.id,
          requestId,
          turns,
          selectorPackVersion,
          referenceAssets,
        });
        if (!queued.ok) {
          await send({
            error: { message: queued.error },
            relay: { phase: "error", logicalStatus: "error", retry_after: queued.error.includes("QUEUE_FULL") ? 5 : undefined },
          });
          await logUsage(key, model, { images }, prompt, started, {
            ok: false,
            status: queued.error.includes("QUEUE_FULL") ? 429 : 503,
            error: queued.error,
          });
          await finish();
          return;
        }
        jobId = queued.job.id;
        if (life.aborted()) {
          const cancelReason = life.reason() === "timeout" ? "TIMEOUT: SSE lifecycle deadline" : `REQUEST_CANCELLED: ${life.reason()}`;
          const cancelled = await cancelJob(jobId, cancelReason);
          const retained = "retained" in cancelled && cancelled.retained;
          const why = retained
            ? "RESULT_UNCERTAIN: stream ended after provider submission; attempt retained for recovery"
            : cancelReason;
          await send({
            error: { message: why },
            relay: {
              phase: "error",
              logicalStatus: retained ? "uncertain" : life.reason() === "disconnect" ? "cancelled" : "error",
              jobId,
            },
          });
          await logUsage(key, model, { images }, prompt, started, { ok: false, status: 499, error: why });
          await finish();
          return;
        }
        await send({
          id: `chatcmpl-${queued.job.id}`,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {} }],
          relay: { phase: "waiting_worker", accountEmail: queued.job.accountEmail, jobId: queued.job.id, requestId },
        });
        let assembled = "";
        let firstSse = 0;
        const ping = setInterval(() => {
          void send({
            id: `chatcmpl-${queued.job.id}`,
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: {} }],
            relay: { phase: "waiting_worker", jobId: queued.job.id, accountEmail: queued.job.accountEmail },
          });
        }, 8000);
        let unsubscribeJob: () => void = () => undefined;
        const jobSettled = new Promise<void>((resolve) => {
          const unsub = subscribeJob(queued.job.id, (ev) => {
            if (ev.type === "phase") {
              void send({
                id: `chatcmpl-${queued.job.id}`,
                object: "chat.completion.chunk",
                model,
                choices: [{ index: 0, delta: {} }],
                relay: { phase: ev.phase, jobId: queued.job.id, requestId },
              });
            }
            if (ev.type === "delta" && ev.text) {
              const chunk = nextSseDelta(assembled, ev.text);
              if (chunk) {
                assembled += chunk;
                if (!firstSse) firstSse = Date.now();
                void send({
                  id: `chatcmpl-${queued.job.id}`,
                  object: "chat.completion.chunk",
                  model,
                  choices: [{ index: 0, delta: { content: chunk } }],
                  relay: { phase: "streaming", jobId: queued.job.id },
                });
              }
            }
            if (ev.type === "done" || ev.type === "error") {
              unsub();
              resolve();
            }
          });
          void waitJob(queued.job.id, queued.job.timeoutMs).then(() => {
            unsub();
            resolve();
          });
          unsubscribeJob = unsub;
        });
        await Promise.race([jobSettled, aborted]);
        clearInterval(ping);
        if (life.aborted()) {
          unsubscribeJob();
          const cancelReason =
            life.reason() === "timeout" ? "TIMEOUT: SSE lifecycle deadline" : `REQUEST_CANCELLED: ${life.reason()}`;
          const cancelled = jobId ? await cancelJob(jobId, cancelReason) : { ok: true as const };
          const retained = "retained" in cancelled && cancelled.retained;
          const why = retained
            ? "RESULT_UNCERTAIN: stream ended after provider submission; attempt retained for recovery"
            : cancelReason;
          await send({
            error: { message: why },
            relay: {
              phase: "error",
              logicalStatus: retained ? "uncertain" : life.reason() === "disconnect" ? "cancelled" : "error",
              partialText: assembled,
              jobId,
            },
          });
          await logUsage(key, model, { images }, prompt, started, { ok: false, status: 499, error: why });
          await finish();
          return;
        }
        const done = await getJob(queued.job.id);
        const text = done?.text || assembled;
        if (!done || done.status !== "done" || !text || text.startsWith("MOCK:")) {
          const error = done?.error || "执行器未返回模型原文";
          const uncertain = /UNCERTAIN/i.test(error);
          await send({
            error: { message: error },
            relay: {
              phase: "error",
              logicalStatus: uncertain ? "uncertain" : "error",
              partialText: assembled || done?.text || "",
              jobId: queued.job.id,
              requestId: queued.job.requestId,
              sse_transport_status: 200,
              sse_logical_status: uncertain ? "uncertain" : "error",
              sse_partial_before_error: Boolean(assembled || done?.text),
            },
          });
          await logUsage(key, model, { images }, prompt, started, { ok: false, status: 504, error });
          await finish();
          return;
        }
        const rest = nextSseDelta(assembled, text);
        if (rest) {
          assembled += rest;
          await send({
            id: `chatcmpl-${queued.job.id}`,
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: { content: rest } }],
          });
        }
        await send({
          id: `chatcmpl-${queued.job.id}`,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          relay: {
            phase: "done",
            logicalStatus: "success",
            accountEmail: queued.job.accountEmail,
            mode: "live",
            jobId: queued.job.id,
            requestId: queued.job.requestId,
            attemptId: done.attemptId,
            workerId: done.workerId,
            firstSseDeltaMs: firstSse ? firstSse - started : null,
            timing: done.timing || null,
            actualModel: done.actualModel || null,
            actualModelLabel: done.actualModelLabel || null,
            modelVerified: done.modelVerified ?? false,
            requested_model: model,
            actual_model: done.actualModel || "unknown",
            actual_model_label: done.actualModelLabel || null,
            model_verified: done.modelVerified ?? false,
            actualProfile: done.actualProfile || null,
            profileVerified: done.profileVerified ?? false,
            requestedModel: model,
            requestedProfile: model === "chatgpt-web-fast" ? "fast" : model === "chatgpt-web-auto" ? "auto" : "exact",
            requested_profile: model === "chatgpt-web-fast" ? "fast" : model === "chatgpt-web-auto" ? "auto" : "exact",
            actual_profile: done.actualProfile || "unknown",
            profile_verified: done.profileVerified ?? false,
            finalText: text,
          },
        });
        await send(sseUsageChunk(model, queued.job.id, estimateTokens(prompt), estimateTokens(text)));
        await logUsage(key, model, { images }, prompt, started, {
          ok: true,
          id: queued.job.id,
          model,
          text,
          accountEmail: queued.job.accountEmail,
          mode: "live",
          requestId: queued.job.requestId,
          traceId: queued.job.traceId,
          attemptId: done.attemptId,
          workerId: done.workerId,
          accountId: done.accountId || undefined,
          proxyId: done.proxyId,
        });
        await finish();
      } catch (err) {
        await send({ error: { message: err instanceof Error ? err.message : "流式失败" }, relay: { phase: "error" } });
        await finish();
      } finally {
        life.dispose();
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

function completion(result: ChatOk, imageCount: number, promptTokens: number, completionTokens: number) {
  return {
    id: `chatcmpl-${result.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    relay: {
      accountEmail: result.accountEmail,
      jobId: result.id,
      mode: result.mode,
      images: imageCount,
      requestId: result.requestId,
      traceId: result.traceId,
      attemptId: result.attemptId,
      workerId: result.workerId,
      accountId: result.accountId,
      proxyId: result.proxyId,
      requested_model: result.requestedModel || result.model,
      actual_model: result.actualModel || "unknown",
      actual_model_label: result.actualModelLabel,
      model_verified: result.modelVerified ?? false,
      requested_profile: result.requestedProfile || "exact",
      actual_profile: result.actualProfile || "unknown",
      profile_verified: result.profileVerified ?? false,
    },
  };
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-api-key, idempotency-key, x-request-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
