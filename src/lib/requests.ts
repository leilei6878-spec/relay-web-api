import { persistenceMode, pgSotActive } from "./persist-mode";
import { uid } from "./utils";

export type RequestStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AttemptStatus = "pending" | "running" | "succeeded" | "failed";

export type RelayRequest = {
  id: string;
  idempotencyKey?: string;
  tenantId?: string;
  keyId?: string;
  provider: "chatgpt" | "gemini" | "leonardo";
  model: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  status: RequestStatus;
  finalAttemptId?: string;
  finalError?: string;
};

export type RelayAttempt = {
  id: string;
  requestId: string;
  jobId?: string;
  accountId?: string | null;
  proxyId?: string;
  workerId?: string;
  leaseId?: string;
  fencingToken?: number;
  startedAt: string;
  completedAt?: string;
  errorCode?: string;
  faultDomain?: string;
  result?: unknown;
  status: AttemptStatus;
};

type Bag = { requests: RelayRequest[]; attempts: RelayAttempt[] };

const mem: Bag = { requests: [], attempts: [] };

export function resetRequestsForTests() {
  mem.requests = [];
  mem.attempts = [];
}

async function persistRow(kind: "request" | "attempt", row: Record<string, unknown>) {
  if (process.env.RELAY_SKIP_DB === "1") return;
  if (persistenceMode() === "file") return;
  try {
    const db = await import("./relay-db");
    if (kind === "request") await db.safeDb(() => db.dbUpsertRequest(row));
    else await db.safeDb(() => db.dbUpsertAttempt(row));
  } catch {
    /* dual-write best-effort outside production (safeDb throws in production) */
  }
}

export async function createRelayRequest(input: {
  id?: string;
  idempotencyKey?: string;
  tenantId?: string;
  keyId?: string;
  provider: "chatgpt" | "gemini" | "leonardo";
  model: string;
}): Promise<{ request: RelayRequest; replay: boolean }> {
  if (pgSotActive()) {
    const row: RelayRequest = {
      id: input.id || uid(),
      idempotencyKey: input.idempotencyKey,
      tenantId: input.tenantId,
      keyId: input.keyId,
      provider: input.provider,
      model: input.model,
      createdAt: new Date().toISOString(),
      status: "queued",
    };
    const db = await import("./relay-db");
    const inserted = await db.dbInsertRequestIdempotent(row as unknown as Record<string, unknown>);
    const request = inserted.request as unknown as RelayRequest;
    if (!inserted.replay) {
      mem.requests.unshift(request);
      mem.requests = mem.requests.slice(0, 2000);
    }
    return { request, replay: inserted.replay };
  }
  if (input.idempotencyKey) {
    const hit = mem.requests.find((r) => r.idempotencyKey === input.idempotencyKey);
    if (hit && (hit.status === "queued" || hit.status === "running" || hit.status === "succeeded")) {
      return { request: hit, replay: true };
    }
  }
  const request: RelayRequest = {
    id: input.id || uid(),
    idempotencyKey: input.idempotencyKey,
    tenantId: input.tenantId,
    keyId: input.keyId,
    provider: input.provider,
    model: input.model,
    createdAt: new Date().toISOString(),
    status: "queued",
  };
  mem.requests.unshift(request);
  mem.requests = mem.requests.slice(0, 2000);
  await persistRow("request", request as unknown as Record<string, unknown>);
  return { request, replay: false };
}

export async function addAttempt(input: {
  id?: string;
  requestId: string;
  jobId?: string;
  accountId?: string | null;
  proxyId?: string;
  workerId?: string;
  leaseId?: string;
  fencingToken?: number;
}): Promise<RelayAttempt> {
  const attempt: RelayAttempt = {
    id: input.id || uid(),
    requestId: input.requestId,
    jobId: input.jobId,
    accountId: input.accountId,
    proxyId: input.proxyId,
    workerId: input.workerId,
    leaseId: input.leaseId,
    fencingToken: input.fencingToken,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  mem.attempts.unshift(attempt);
  const req = mem.requests.find((r) => r.id === input.requestId);
  if (req) {
    if (!req.startedAt) req.startedAt = attempt.startedAt;
    req.status = "running";
    await persistRow("request", req as unknown as Record<string, unknown>);
  }
  await persistRow("attempt", attempt as unknown as Record<string, unknown>);
  return attempt;
}

export async function finishAttempt(
  attemptId: string,
  result: {
    ok: boolean;
    errorCode?: string;
    faultDomain?: string;
    result?: unknown;
    workerId?: string;
    leaseId?: string;
    fencingToken?: number;
  },
) {
  const attempt = mem.attempts.find((a) => a.id === attemptId);
  if (!attempt) return null;
  attempt.status = result.ok ? "succeeded" : "failed";
  attempt.completedAt = new Date().toISOString();
  attempt.errorCode = result.errorCode;
  attempt.faultDomain = result.faultDomain;
  attempt.result = result.result;
  if (result.workerId) attempt.workerId = result.workerId;
  if (result.leaseId) attempt.leaseId = result.leaseId;
  if (result.fencingToken !== undefined) attempt.fencingToken = result.fencingToken;
  await persistRow("attempt", attempt as unknown as Record<string, unknown>);
  return attempt;
}

export async function completeRequest(
  requestId: string,
  outcome: { ok: boolean; finalAttemptId?: string; finalError?: string },
) {
  const req = mem.requests.find((r) => r.id === requestId);
  if (!req) return null;
  req.status = outcome.ok ? "succeeded" : req.status === "cancelled" ? "cancelled" : "failed";
  req.completedAt = new Date().toISOString();
  req.finalAttemptId = outcome.finalAttemptId;
  req.finalError = outcome.finalError;
  await persistRow("request", req as unknown as Record<string, unknown>);
  return req;
}

export async function cancelRequest(requestId: string, error: string) {
  const req = mem.requests.find((r) => r.id === requestId);
  if (!req) return null;
  if (req.status === "succeeded") return req;
  req.status = "cancelled";
  req.completedAt = new Date().toISOString();
  req.finalError = error;
  await persistRow("request", req as unknown as Record<string, unknown>);
  return req;
}

export function getRequest(id: string) {
  return mem.requests.find((r) => r.id === id) ?? null;
}

export function attemptsFor(requestId: string) {
  return mem.attempts.filter((a) => a.requestId === requestId);
}

export function listRequests(limit = 50) {
  return mem.requests.slice(0, limit);
}
