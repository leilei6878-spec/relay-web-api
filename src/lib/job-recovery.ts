import { resolveRetrySafety, type RetrySafety } from "./fault-matrix.ts";

export type SubmissionCheckpoint = {
  submissionState?: string | null;
  retrySafety?: RetrySafety | string | null;
  submissionRank?: number;
  retrySafetyRank?: number;
};

const SUBMISSION_RANK: Record<string, number> = {
  PREPARING: 0,
  COMPOSER_READY: 1,
  INPUT_READY: 2,
  SUBMITTING: 3,
  SUBMISSION_UNCERTAIN: 4,
  SUBMITTED: 5,
  GENERATING: 6,
  RESULT_DETECTED: 7,
  RESULT_UNCERTAIN: 8,
  RESULT_VALIDATED: 9,
  COMPLETED: 10,
};

const SAFETY_RANK: Record<RetrySafety, number> = {
  SAFE: 0,
  UNKNOWN: 1,
  UNSAFE: 2,
};

export function submissionStateRank(state?: string | null) {
  return SUBMISSION_RANK[String(state || "").toUpperCase()] ?? -1;
}

export function retrySafetyRank(safety?: string | null) {
  const value = resolveRetrySafety(safety);
  return SAFETY_RANK[value];
}

/** Apply a lease-fenced worker checkpoint without allowing state/safety rollback. */
export function applySubmissionCheckpoint<T extends SubmissionCheckpoint>(
  current: T,
  incoming: SubmissionCheckpoint,
): T & SubmissionCheckpoint & Required<Pick<SubmissionCheckpoint, "submissionRank" | "retrySafetyRank">> {
  const currentStateRank = Math.max(
    Number(current.submissionRank ?? -1),
    submissionStateRank(current.submissionState),
  );
  const incomingStateRank = Math.max(
    Number(incoming.submissionRank ?? -1),
    submissionStateRank(incoming.submissionState),
  );
  const currentSafety = resolveRetrySafety(current.retrySafety, current.submissionState);
  const incomingSafety = resolveRetrySafety(incoming.retrySafety, incoming.submissionState);
  const currentSafetyRank = Math.max(
    Number(current.retrySafetyRank ?? -1),
    SAFETY_RANK[currentSafety],
  );
  const incomingSafetyRank = Math.max(
    Number(incoming.retrySafetyRank ?? -1),
    SAFETY_RANK[incomingSafety],
  );
  const stateAdvances = incomingStateRank >= currentStateRank;
  const safetyAdvances = incomingSafetyRank >= currentSafetyRank;
  return {
    ...current,
    ...(stateAdvances && incoming.submissionState
      ? { submissionState: String(incoming.submissionState).toUpperCase() }
      : {}),
    ...(safetyAdvances ? { retrySafety: incomingSafety } : {}),
    submissionRank: Math.max(currentStateRank, incomingStateRank),
    retrySafetyRank: Math.max(currentSafetyRank, incomingSafetyRank),
  };
}

export function resetSubmissionForRetry<T extends SubmissionCheckpoint>(
  job: T,
): T & {
  submissionState: "PREPARING";
  retrySafety: "SAFE";
  submissionRank: number;
  retrySafetyRank: number;
} {
  return {
    ...job,
    submissionState: "PREPARING",
    retrySafety: "SAFE",
    submissionRank: SUBMISSION_RANK.PREPARING,
    retrySafetyRank: SAFETY_RANK.SAFE,
  };
}

export type RecoveryDisposition = "requeue" | "uncertain" | "dead";

/** UNKNOWN/UNSAFE work may have reached the provider and must never execute again. */
export function recoveryDisposition(
  job: SubmissionCheckpoint & { attempts?: number; error?: string },
  maxRetry: number,
): RecoveryDisposition {
  const safety = resolveRetrySafety(job.retrySafety, job.submissionState, job.error);
  if (safety !== "SAFE") return "uncertain";
  return Number(job.attempts || 0) < maxRetry ? "requeue" : "dead";
}
