import type { FaultClass } from "./faults";

export const ErrorCode = {
  ACCOUNT_SESSION_EXPIRED: "ACCOUNT_SESSION_EXPIRED",
  ACCOUNT_BANNED: "ACCOUNT_BANNED",
  ACCOUNT_RATE_LIMIT: "ACCOUNT_RATE_LIMIT",
  PROXY_UNAVAILABLE: "PROXY_UNAVAILABLE",
  PROXY_TIMEOUT: "PROXY_TIMEOUT",
  PROXY_IDENTITY_MISMATCH: "PROXY_IDENTITY_MISMATCH",
  WORKER_CRASH: "WORKER_CRASH",
  WORKER_TIMEOUT: "WORKER_TIMEOUT",
  PROVIDER_DOM_CHANGED: "PROVIDER_DOM_CHANGED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  GENERATION_TIMEOUT: "GENERATION_TIMEOUT",
  IMAGE_NOT_FOUND: "IMAGE_NOT_FOUND",
  SUBMISSION_UNCERTAIN: "SUBMISSION_UNCERTAIN",
  RESULT_UNCERTAIN: "RESULT_UNCERTAIN",
  REQUEST_CANCELLED: "REQUEST_CANCELLED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  STALE_LEASE: "STALE_LEASE",
  MODEL_MISMATCH: "MODEL_MISMATCH",
  MODEL_SELECTION_UNCONFIRMED: "MODEL_SELECTION_UNCONFIRMED",
  LEONARDO_LOGIN_REQUIRED: "LEONARDO_LOGIN_REQUIRED",
  LEONARDO_SESSION_EXPIRED: "LEONARDO_SESSION_EXPIRED",
  LEONARDO_CHALLENGE: "LEONARDO_CHALLENGE",
  LEONARDO_TOKEN_EXHAUSTED: "LEONARDO_TOKEN_EXHAUSTED",
  LEONARDO_QUEUE_FULL: "LEONARDO_QUEUE_FULL",
  LEONARDO_RATE_LIMITED: "LEONARDO_RATE_LIMITED",
  LEONARDO_ACCOUNT_RESTRICTED: "LEONARDO_ACCOUNT_RESTRICTED",
  LEONARDO_MODEL_UNAVAILABLE: "LEONARDO_MODEL_UNAVAILABLE",
  LEONARDO_DOM_CHANGED: "LEONARDO_DOM_CHANGED",
  LEONARDO_GENERATION_FAILED: "LEONARDO_GENERATION_FAILED",
  LEONARDO_GENERATION_TIMEOUT: "LEONARDO_GENERATION_TIMEOUT",
  LEONARDO_RESULT_NOT_FOUND: "LEONARDO_RESULT_NOT_FOUND",
  LEONARDO_DOWNLOAD_FAILED: "LEONARDO_DOWNLOAD_FAILED",
  LEONARDO_PROXY_UNAVAILABLE: "LEONARDO_PROXY_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type AccountHealthEffect = "none" | "failCount" | "invalid" | "banned" | "cool";
export type CircuitEffect = "none" | "trip" | "probe";

export type FaultDecision = {
  code: ErrorCode;
  fault_domain: FaultClass;
  retry_same_account: boolean;
  switch_account: boolean;
  switch_proxy: boolean;
  provider_circuit_effect: CircuitEffect;
  account_health_effect: AccountHealthEffect;
};

const accountSwitch = (
  code: ErrorCode,
  health: AccountHealthEffect,
  domain: FaultClass = "account",
): FaultDecision => ({
  code,
  fault_domain: domain,
  retry_same_account: false,
  switch_account: true,
  switch_proxy: false,
  provider_circuit_effect: "none",
  account_health_effect: health,
});

export const FAILURE_MATRIX: Record<ErrorCode, FaultDecision> = {
  ACCOUNT_SESSION_EXPIRED: accountSwitch("ACCOUNT_SESSION_EXPIRED", "invalid"),
  ACCOUNT_BANNED: accountSwitch("ACCOUNT_BANNED", "banned"),
  ACCOUNT_RATE_LIMIT: accountSwitch("ACCOUNT_RATE_LIMIT", "cool"),
  PROXY_UNAVAILABLE: {
    code: "PROXY_UNAVAILABLE",
    fault_domain: "proxy",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  PROXY_TIMEOUT: {
    code: "PROXY_TIMEOUT",
    fault_domain: "proxy",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  PROXY_IDENTITY_MISMATCH: {
    code: "PROXY_IDENTITY_MISMATCH",
    fault_domain: "proxy",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  WORKER_CRASH: {
    code: "WORKER_CRASH",
    fault_domain: "worker",
    retry_same_account: true,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  WORKER_TIMEOUT: {
    code: "WORKER_TIMEOUT",
    fault_domain: "worker",
    retry_same_account: true,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  PROVIDER_DOM_CHANGED: {
    code: "PROVIDER_DOM_CHANGED",
    fault_domain: "provider",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "trip",
    account_health_effect: "none",
  },
  PROVIDER_UNAVAILABLE: {
    code: "PROVIDER_UNAVAILABLE",
    fault_domain: "provider",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "trip",
    account_health_effect: "none",
  },
  GENERATION_TIMEOUT: {
    code: "GENERATION_TIMEOUT",
    fault_domain: "infra",
    retry_same_account: true,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  IMAGE_NOT_FOUND: {
    code: "IMAGE_NOT_FOUND",
    fault_domain: "provider",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  SUBMISSION_UNCERTAIN: {
    code: "SUBMISSION_UNCERTAIN",
    fault_domain: "provider",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  RESULT_UNCERTAIN: {
    code: "RESULT_UNCERTAIN",
    fault_domain: "provider",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  REQUEST_CANCELLED: {
    code: "REQUEST_CANCELLED",
    fault_domain: "client",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  INTERNAL_ERROR: {
    code: "INTERNAL_ERROR",
    fault_domain: "infra",
    retry_same_account: true,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  STALE_LEASE: {
    code: "STALE_LEASE",
    fault_domain: "worker",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  MODEL_MISMATCH: {
    code: "MODEL_MISMATCH",
    fault_domain: "provider",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  MODEL_SELECTION_UNCONFIRMED: {
    code: "MODEL_SELECTION_UNCONFIRMED",
    fault_domain: "provider",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  LEONARDO_LOGIN_REQUIRED: accountSwitch("LEONARDO_LOGIN_REQUIRED", "invalid"),
  LEONARDO_SESSION_EXPIRED: accountSwitch("LEONARDO_SESSION_EXPIRED", "invalid"),
  LEONARDO_CHALLENGE: {
    code: "LEONARDO_CHALLENGE",
    fault_domain: "provider",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  LEONARDO_TOKEN_EXHAUSTED: accountSwitch("LEONARDO_TOKEN_EXHAUSTED", "cool"),
  LEONARDO_QUEUE_FULL: accountSwitch("LEONARDO_QUEUE_FULL", "cool"),
  LEONARDO_RATE_LIMITED: accountSwitch("LEONARDO_RATE_LIMITED", "cool"),
  LEONARDO_ACCOUNT_RESTRICTED: accountSwitch("LEONARDO_ACCOUNT_RESTRICTED", "banned"),
  LEONARDO_MODEL_UNAVAILABLE: accountSwitch("LEONARDO_MODEL_UNAVAILABLE", "cool"),
  LEONARDO_DOM_CHANGED: {
    code: "LEONARDO_DOM_CHANGED",
    fault_domain: "provider",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "trip",
    account_health_effect: "none",
  },
  LEONARDO_GENERATION_FAILED: accountSwitch("LEONARDO_GENERATION_FAILED", "failCount", "provider"),
  LEONARDO_GENERATION_TIMEOUT: {
    code: "LEONARDO_GENERATION_TIMEOUT",
    fault_domain: "infra",
    retry_same_account: true,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  LEONARDO_RESULT_NOT_FOUND: {
    code: "LEONARDO_RESULT_NOT_FOUND",
    fault_domain: "provider",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  LEONARDO_DOWNLOAD_FAILED: {
    code: "LEONARDO_DOWNLOAD_FAILED",
    fault_domain: "infra",
    retry_same_account: true,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  LEONARDO_PROXY_UNAVAILABLE: {
    code: "LEONARDO_PROXY_UNAVAILABLE",
    fault_domain: "proxy",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
};

export function normalizeError(error?: string, faultHint?: string): ErrorCode {
  const t = `${faultHint || ""} ${error || ""}`.toUpperCase();
  if (t.includes("STALE_LEASE")) return "STALE_LEASE";
  if (t.includes("SUBMISSION_UNCERTAIN")) return "SUBMISSION_UNCERTAIN";
  if (t.includes("RESULT_UNCERTAIN")) return "RESULT_UNCERTAIN";
  if (t.includes("LEONARDO_LOGIN_REQUIRED")) return "LEONARDO_LOGIN_REQUIRED";
  if (t.includes("LEONARDO_SESSION_EXPIRED")) return "LEONARDO_SESSION_EXPIRED";
  if (t.includes("LEONARDO_CHALLENGE")) return "LEONARDO_CHALLENGE";
  if (t.includes("LEONARDO_TOKEN_EXHAUSTED") || (t.includes("TOKEN_EXHAUSTED") && t.includes("LEONARDO"))) {
    return "LEONARDO_TOKEN_EXHAUSTED";
  }
  if (t.includes("LEONARDO_QUEUE_FULL") || (t.includes("QUEUE_FULL") && t.includes("LEONARDO"))) return "LEONARDO_QUEUE_FULL";
  if (t.includes("LEONARDO_RATE_LIMITED")) return "LEONARDO_RATE_LIMITED";
  if (t.includes("LEONARDO_ACCOUNT_RESTRICTED")) return "LEONARDO_ACCOUNT_RESTRICTED";
  if (t.includes("LEONARDO_MODEL_UNAVAILABLE") || (t.includes("MODEL_UNAVAILABLE") && t.includes("LEONARDO"))) {
    return "LEONARDO_MODEL_UNAVAILABLE";
  }
  if (t.includes("LEONARDO_DOM_CHANGED")) return "LEONARDO_DOM_CHANGED";
  if (t.includes("LEONARDO_GENERATION_TIMEOUT")) return "LEONARDO_GENERATION_TIMEOUT";
  if (t.includes("LEONARDO_RESULT_NOT_FOUND")) return "LEONARDO_RESULT_NOT_FOUND";
  if (t.includes("LEONARDO_DOWNLOAD_FAILED")) return "LEONARDO_DOWNLOAD_FAILED";
  if (t.includes("LEONARDO_PROXY_UNAVAILABLE")) return "LEONARDO_PROXY_UNAVAILABLE";
  if (t.includes("LEONARDO_GENERATION_FAILED")) return "LEONARDO_GENERATION_FAILED";
  if (t.includes("SEND_NOT_ACKED") || t.includes("MESSAGE DID NOT ENTER")) return "SUBMISSION_UNCERTAIN";
  if (t.includes("MODEL_SELECTION_UNCONFIRMED")) return "MODEL_SELECTION_UNCONFIRMED";
  if (t.includes("MODEL_MISMATCH")) return "MODEL_MISMATCH";
  if (t.includes("CHALLENGE")) return "ACCOUNT_RATE_LIMIT";
  if (t.includes("LOGIN_REQUIRED")) return "ACCOUNT_SESSION_EXPIRED";
  if (t.includes("DOM_CHANGED") || t.includes("DOM_UNKNOWN") || t.includes("SELECTOR") || t.includes("选择器")) {
    return "PROVIDER_DOM_CHANGED";
  }
  if (t.includes("PROVIDER_UNAVAILABLE") || t.includes("PROVIDER_ERROR")) return "PROVIDER_UNAVAILABLE";
  if (t.includes("IMAGE_NOT_FOUND") || t.includes("未返回图片")) return "IMAGE_NOT_FOUND";
  if (t.includes("BANNED") || t.includes("封")) return "ACCOUNT_BANNED";
  if (t.includes("RATE_LIMIT") || t.includes("429")) return "ACCOUNT_RATE_LIMIT";
  if (t.includes("SESSION") || t.includes("LOGIN") || t.includes("COOKIE") || t.includes("SESSION_INVALID")) {
    return "ACCOUNT_SESSION_EXPIRED";
  }
  if (t.includes("IDENTITY_MISMATCH")) return "PROXY_IDENTITY_MISMATCH";
  if (t.includes("PROXY") && t.includes("TIMEOUT")) return "PROXY_TIMEOUT";
  if (t.includes("PROXY") || t.includes("代理")) return "PROXY_UNAVAILABLE";
  if (t.includes("WORKER_DEAD") || t.includes("WORKER_CRASH") || t.includes("执行器掉线")) return "WORKER_CRASH";
  if (t.includes("CANCEL")) return "REQUEST_CANCELLED";
  if (t.includes("GENERATION_TIMEOUT")) return "GENERATION_TIMEOUT";
  if (t.includes("TIMEOUT") || t.includes("超时")) return "WORKER_TIMEOUT";
  return "INTERNAL_ERROR";
}

export function decide(error?: string, faultHint?: string): FaultDecision {
  return FAILURE_MATRIX[normalizeError(error, faultHint)];
}

export function shouldSwitchAccount(error?: string, faultHint?: string) {
  return decide(error, faultHint).switch_account;
}

export function shouldTripCircuit(error?: string, faultHint?: string) {
  return decide(error, faultHint).provider_circuit_effect === "trip";
}

export function mutatesAccountHealth(error?: string, faultHint?: string) {
  return decide(error, faultHint).account_health_effect !== "none";
}

export const POST_SUBMIT_STATES = new Set([
  "SUBMITTED",
  "GENERATING",
  "RESULT_DETECTED",
  "RESULT_VALIDATED",
  "COMPLETED",
  "SUBMISSION_UNCERTAIN",
  "RESULT_UNCERTAIN",
]);

export type RetrySafety = "SAFE" | "UNSAFE" | "UNKNOWN";

export function resolveRetrySafety(
  safety?: string | null,
  submissionState?: string | null,
  error?: string | null,
): RetrySafety {
  const s = String(safety || "").toUpperCase();
  if (s === "SAFE" || s === "UNSAFE" || s === "UNKNOWN") return s as RetrySafety;
  const st = String(submissionState || "").toUpperCase();
  if (st === "SUBMISSION_UNCERTAIN" || st === "SUBMITTING") return "UNKNOWN";
  if (POST_SUBMIT_STATES.has(st)) return "UNSAFE";
  const t = String(error || "").toUpperCase();
  if (t.includes("SUBMISSION_UNCERTAIN") || t.includes("SEND_NOT_ACKED")) return "UNKNOWN";
  if (t.includes("RESULT_UNCERTAIN")) return "UNSAFE";
  return "SAFE";
}

/** retrySafety beats submissionState beats fault code. UNKNOWN/UNSAFE never regenerate. */
export function decideWithSafety(
  error?: string,
  faultHint?: string,
  safety?: string | null,
  submissionState?: string | null,
): FaultDecision {
  const base = decide(error, faultHint);
  const resolved = resolveRetrySafety(safety, submissionState, error);
  if (resolved === "UNSAFE" || resolved === "UNKNOWN") {
    return { ...base, retry_same_account: false, switch_account: false, switch_proxy: false };
  }
  return base;
}
