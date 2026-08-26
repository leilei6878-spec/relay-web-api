import type { FaultClass } from "./faults";

export const ErrorCode = {
  ACCOUNT_SESSION_EXPIRED: "ACCOUNT_SESSION_EXPIRED",
  ACCOUNT_BANNED: "ACCOUNT_BANNED",
  ACCOUNT_RATE_LIMIT: "ACCOUNT_RATE_LIMIT",
  PROXY_UNAVAILABLE: "PROXY_UNAVAILABLE",
  PROXY_TIMEOUT: "PROXY_TIMEOUT",
  WORKER_CRASH: "WORKER_CRASH",
  WORKER_TIMEOUT: "WORKER_TIMEOUT",
  PROVIDER_DOM_CHANGED: "PROVIDER_DOM_CHANGED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  GENERATION_TIMEOUT: "GENERATION_TIMEOUT",
  IMAGE_NOT_FOUND: "IMAGE_NOT_FOUND",
  REQUEST_CANCELLED: "REQUEST_CANCELLED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  STALE_LEASE: "STALE_LEASE",
  MODEL_MISMATCH: "MODEL_MISMATCH",
  MODEL_SELECTION_UNCONFIRMED: "MODEL_SELECTION_UNCONFIRMED",
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

export const FAILURE_MATRIX: Record<ErrorCode, FaultDecision> = {
  ACCOUNT_SESSION_EXPIRED: {
    code: "ACCOUNT_SESSION_EXPIRED",
    fault_domain: "account",
    retry_same_account: false,
    switch_account: true,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "invalid",
  },
  ACCOUNT_BANNED: {
    code: "ACCOUNT_BANNED",
    fault_domain: "account",
    retry_same_account: false,
    switch_account: true,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "banned",
  },
  ACCOUNT_RATE_LIMIT: {
    code: "ACCOUNT_RATE_LIMIT",
    fault_domain: "account",
    retry_same_account: false,
    switch_account: true,
    switch_proxy: false,
    provider_circuit_effect: "none",
    account_health_effect: "cool",
  },
  PROXY_UNAVAILABLE: {
    code: "PROXY_UNAVAILABLE",
    fault_domain: "proxy",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: true,
    provider_circuit_effect: "none",
    account_health_effect: "none",
  },
  PROXY_TIMEOUT: {
    code: "PROXY_TIMEOUT",
    fault_domain: "proxy",
    retry_same_account: false,
    switch_account: false,
    switch_proxy: true,
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
};

export function normalizeError(error?: string, faultHint?: string): ErrorCode {
  const t = `${faultHint || ""} ${error || ""}`.toUpperCase();
  if (t.includes("STALE_LEASE")) return "STALE_LEASE";
  if (t.includes("MODEL_SELECTION_UNCONFIRMED")) return "MODEL_SELECTION_UNCONFIRMED";
  if (t.includes("MODEL_MISMATCH")) return "MODEL_MISMATCH";
  if (t.includes("CHALLENGE")) return "ACCOUNT_RATE_LIMIT";
  if (t.includes("LOGIN_REQUIRED")) return "ACCOUNT_SESSION_EXPIRED";
  if (t.includes("DOM_CHANGED") || t.includes("DOM_UNKNOWN") || t.includes("SELECTOR") || t.includes("选择器")) return "PROVIDER_DOM_CHANGED";
  if (t.includes("PROVIDER_UNAVAILABLE") || t.includes("PROVIDER_ERROR")) return "PROVIDER_UNAVAILABLE";
  if (t.includes("IMAGE_NOT_FOUND") || t.includes("未返回图片")) return "IMAGE_NOT_FOUND";
  if (t.includes("BANNED") || t.includes("封")) return "ACCOUNT_BANNED";
  if (t.includes("RATE_LIMIT") || t.includes("429")) return "ACCOUNT_RATE_LIMIT";
  if (t.includes("SESSION") || t.includes("LOGIN") || t.includes("COOKIE") || t.includes("SESSION_INVALID")) {
    return "ACCOUNT_SESSION_EXPIRED";
  }
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
