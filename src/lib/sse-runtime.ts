export type SseLifecycle = {
  signal: AbortSignal;
  aborted: () => boolean;
  reason: () => "none" | "disconnect" | "timeout" | "cancel";
  dispose: () => void;
};

/**
 * SSE lifecycle: disconnect, cancellation, timeout.
 * Tokenizer-level streaming is not a launch blocker; this covers control plane events.
 */
export function attachSseLifecycle(opts: {
  signal?: AbortSignal;
  timeoutMs: number;
  onAbort?: (reason: "disconnect" | "timeout" | "cancel") => void;
}): SseLifecycle {
  const ac = new AbortController();
  let reason: "none" | "disconnect" | "timeout" | "cancel" = "none";
  const fire = (r: "disconnect" | "timeout" | "cancel") => {
    if (reason !== "none") return;
    reason = r;
    opts.onAbort?.(r);
    if (!ac.signal.aborted) ac.abort(r);
  };
  const timer = setTimeout(() => fire("timeout"), Math.max(1, opts.timeoutMs));
  const onDisconnect = () => fire("disconnect");
  opts.signal?.addEventListener("abort", onDisconnect, { once: true });
  return {
    signal: ac.signal,
    aborted: () => reason !== "none",
    reason: () => reason,
    dispose: () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onDisconnect);
    },
  };
}

export async function enqueueWithBackpressure(
  controller: { enqueue: (c: Uint8Array) => void; desiredSize: number | null },
  bytes: Uint8Array,
) {
  controller.enqueue(bytes);
  let spins = 0;
  while (controller.desiredSize !== null && controller.desiredSize <= 0 && spins < 200) {
    await new Promise((r) => setTimeout(r, 10));
    spins += 1;
  }
}

export function sseUsageChunk(model: string, id: string, promptTokens: number, completionTokens: number) {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    relay: { phase: "usage" },
  };
}
