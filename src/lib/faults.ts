import { FAILURE_MATRIX, normalizeError, type ErrorCode, type FaultDecision } from "./fault-matrix";

export type FaultClass = "worker" | "account" | "proxy" | "provider" | "client" | "infra";

export const FaultCode = {
  STALE_LEASE: "STALE_LEASE",
  SESSION_INVALID: "SESSION_INVALID",
  ACCOUNT_BANNED: "ACCOUNT_BANNED",
  PROXY_UNAVAILABLE: "PROXY_UNAVAILABLE",
  MODEL_MISMATCH: "MODEL_MISMATCH",
  DOM_CHANGED: "DOM_CHANGED",
  IMAGE_NOT_FOUND: "IMAGE_NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  WORKER_DEAD: "WORKER_DEAD",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  IDEMPOTENT_REPLAY: "IDEMPOTENT_REPLAY",
  ACCOUNT_SESSION_EXPIRED: "ACCOUNT_SESSION_EXPIRED",
  ACCOUNT_RATE_LIMIT: "ACCOUNT_RATE_LIMIT",
  PROXY_TIMEOUT: "PROXY_TIMEOUT",
  WORKER_CRASH: "WORKER_CRASH",
  WORKER_TIMEOUT: "WORKER_TIMEOUT",
  PROVIDER_DOM_CHANGED: "PROVIDER_DOM_CHANGED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  GENERATION_TIMEOUT: "GENERATION_TIMEOUT",
  REQUEST_CANCELLED: "REQUEST_CANCELLED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export function classifyError(error?: string): FaultClass {
  return FAILURE_MATRIX[normalizeError(error)].fault_domain;
}

export function isAccountFault(fault: FaultClass) {
  return fault === "account";
}

export function decisionFor(error?: string, faultHint?: string): FaultDecision {
  return FAILURE_MATRIX[normalizeError(error, faultHint)];
}

export function errorCodeOf(error?: string, faultHint?: string): ErrorCode {
  return normalizeError(error, faultHint);
}

export { FAILURE_MATRIX, normalizeError };
