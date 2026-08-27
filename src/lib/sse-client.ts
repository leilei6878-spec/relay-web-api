export type LogicalStatus = "success" | "error" | "cancelled" | "uncertain";

export type SseDeltaMeta = {
  accountEmail?: string;
  mode?: string;
  phase?: string;
  replace?: boolean;
};

export type SseOutcome = {
  transportStatus: number;
  logicalStatus: LogicalStatus;
  text: string;
  partialText: string;
  error?: { message?: string };
  finishReason?: string | null;
  completed: boolean;
  requestId?: string;
  jobId?: string;
  id?: string;
  mode?: string;
  accountEmail?: string;
  phase?: string;
  ssePartialBeforeError: boolean;
  requestedModel?: string;
  actualModel?: string;
  actualModelLabel?: string;
  modelVerified?: boolean;
  requestedProfile?: string;
  actualProfile?: string;
  profileVerified?: boolean;
};

export function phaseFromLogical(status: LogicalStatus): "done" | "error" {
  return status === "success" ? "done" : "error";
}

export function historyBadgeOk(status: LogicalStatus): boolean {
  return status === "success";
}

export function classifySseOutcome(input: {
  transportStatus: number;
  text?: string;
  partialText?: string;
  error?: { message?: string };
  phase?: string;
  finishReason?: string | null;
  logicalStatus?: LogicalStatus;
  aborted?: boolean;
  id?: string;
  mode?: string;
  accountEmail?: string;
  requestId?: string;
  jobId?: string;
  requestedModel?: string;
  actualModel?: string;
  actualModelLabel?: string;
  modelVerified?: boolean;
  requestedProfile?: string;
  actualProfile?: string;
  profileVerified?: boolean;
}): SseOutcome {
  const partialText = input.partialText || input.text || "";
  const text = input.text || partialText;
  const msg = input.error?.message || "";
  const base = {
    transportStatus: input.transportStatus,
    text,
    partialText,
    id: input.id,
    mode: input.mode,
    accountEmail: input.accountEmail,
    requestId: input.requestId,
    jobId: input.jobId,
    requestedModel: input.requestedModel,
    actualModel: input.actualModel,
    actualModelLabel: input.actualModelLabel,
    modelVerified: input.modelVerified,
    requestedProfile: input.requestedProfile,
    actualProfile: input.actualProfile,
    profileVerified: input.profileVerified,
    ssePartialBeforeError: Boolean(msg && partialText),
  };
  if (input.logicalStatus && input.logicalStatus !== "success") {
    const logicalStatus = input.logicalStatus;
    return {
      ...base,
      logicalStatus,
      error: input.error || {
        message:
          logicalStatus === "cancelled"
            ? "REQUEST_CANCELLED"
            : logicalStatus === "uncertain"
              ? "RESULT_UNCERTAIN"
              : "stream failed",
      },
      finishReason: logicalStatus,
      completed: false,
      phase: "error",
      ssePartialBeforeError: Boolean(partialText),
    };
  }
  if (input.aborted) {
    return {
      ...base,
      logicalStatus: "cancelled",
      error: input.error || { message: "REQUEST_CANCELLED" },
      finishReason: "cancelled",
      completed: false,
      phase: input.phase || "error",
    };
  }
  const uncertain = /UNCERTAIN/i.test(msg);
  if (msg) {
    return {
      ...base,
      logicalStatus: uncertain ? "uncertain" : "error",
      error: input.error,
      finishReason: input.finishReason || (uncertain ? "uncertain" : "error"),
      completed: false,
      phase: input.phase || "error",
    };
  }
  const done = input.phase === "done" || input.finishReason === "stop";
  if (done && partialText) {
    return {
      ...base,
      logicalStatus: "success",
      finishReason: "stop",
      completed: true,
      phase: "done",
    };
  }
  if (partialText) {
    return {
      ...base,
      logicalStatus: "uncertain",
      error: { message: "RESULT_UNCERTAIN: stream ended without completion" },
      finishReason: "uncertain",
      completed: false,
      phase: input.phase || "error",
      ssePartialBeforeError: true,
    };
  }
  return {
    ...base,
    logicalStatus: "error",
    error: { message: "empty stream" },
    finishReason: "error",
    completed: false,
    phase: "error",
  };
}

export async function readSse(
  res: Response,
  onDelta?: (delta: string, meta: SseDeltaMeta) => void,
): Promise<SseOutcome> {
  const reader = res.body?.getReader();
  if (!reader) {
    return classifySseOutcome({
      transportStatus: res.status,
      error: { message: "无法读取流" },
    });
  }
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let id = "";
  let mode = "";
  let accountEmail = "";
  let phase = "";
  let finishReason: string | null = null;
  let logicalStatus: LogicalStatus | undefined;
  let partialText = "";
  let requestId = "";
  let jobId = "";
  let error: { message?: string } | undefined;
  let requestedModel = "";
  let actualModel = "";
  let actualModelLabel = "";
  let modelVerified: boolean | undefined;
  let requestedProfile = "";
  let actualProfile = "";
  let profileVerified: boolean | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as {
          id?: string;
          error?: { message?: string };
          choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
          relay?: {
            accountEmail?: string;
            mode?: string;
            phase?: string;
            finalText?: string;
            requestId?: string;
            jobId?: string;
            logicalStatus?: string;
            partialText?: string;
            requestedModel?: string;
            actualModel?: string;
            actualModelLabel?: string;
            modelVerified?: boolean;
            requestedProfile?: string;
            actualProfile?: string;
            profileVerified?: boolean;
            requested_model?: string;
            actual_model?: string;
            actual_model_label?: string;
            model_verified?: boolean;
            requested_profile?: string;
            actual_profile?: string;
            profile_verified?: boolean;
          };
        };
        if (json.id) id = json.id;
        if (json.relay?.accountEmail) accountEmail = json.relay.accountEmail;
        if (json.relay?.mode) mode = json.relay.mode;
        if (json.relay?.phase) phase = json.relay.phase;
        if (
          json.relay?.logicalStatus === "success" ||
          json.relay?.logicalStatus === "error" ||
          json.relay?.logicalStatus === "cancelled" ||
          json.relay?.logicalStatus === "uncertain"
        ) {
          logicalStatus = json.relay.logicalStatus;
        }
        if (json.relay?.partialText !== undefined) partialText = json.relay.partialText;
        requestedModel = json.relay?.requested_model || json.relay?.requestedModel || requestedModel;
        actualModel = json.relay?.actual_model || json.relay?.actualModel || actualModel;
        actualModelLabel = json.relay?.actual_model_label || json.relay?.actualModelLabel || actualModelLabel;
        if (typeof json.relay?.model_verified === "boolean") modelVerified = json.relay.model_verified;
        else if (typeof json.relay?.modelVerified === "boolean") modelVerified = json.relay.modelVerified;
        requestedProfile = json.relay?.requested_profile || json.relay?.requestedProfile || requestedProfile;
        actualProfile = json.relay?.actual_profile || json.relay?.actualProfile || actualProfile;
        if (typeof json.relay?.profile_verified === "boolean") profileVerified = json.relay.profile_verified;
        else if (typeof json.relay?.profileVerified === "boolean") profileVerified = json.relay.profileVerified;
        if (json.relay?.requestId) requestId = json.relay.requestId;
        if (json.relay?.jobId) jobId = json.relay.jobId;
        const fr = json.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
        if (json.error?.message) error = json.error;
        if (json.relay?.finalText) {
          text = json.relay.finalText;
          onDelta?.(json.relay.finalText, { accountEmail, mode, phase: json.relay.phase, replace: true });
        } else {
          const piece = json.choices?.[0]?.delta?.content || "";
          if (piece) {
            text += piece;
            onDelta?.(piece, { accountEmail, mode, phase: json.relay?.phase });
          } else {
            onDelta?.("", { accountEmail, mode, phase: json.relay?.phase });
          }
        }
      } catch {
        /* skip malformed chunk */
      }
    }
  }
  return classifySseOutcome({
    transportStatus: res.status,
    text,
    partialText,
    error,
    phase,
    finishReason,
    logicalStatus,
    id,
    mode,
    accountEmail,
    requestId,
    jobId: jobId || id,
    requestedModel: requestedModel || undefined,
    actualModel: actualModel || undefined,
    actualModelLabel: actualModelLabel || undefined,
    modelVerified,
    requestedProfile: requestedProfile || undefined,
    actualProfile: actualProfile || undefined,
    profileVerified,
  });
}
