import { inspectSession } from "../session-probe";
import type { Account, Platform } from "../types";

export type SessionWrite = {
  accountId: string;
  baseVersion: number;
  nextVersion: number;
  stateJson: string;
};

export type SessionDecision =
  | { ok: true; sessionVersion: number; lastRefreshAt: string }
  | { ok: false; code: "STALE_SESSION_UPDATE" | "SESSION_INVALID" | "SESSION_EXPIRED"; error: string };

export function canWriteSession(storedVersion: number, workerBaseVersion: number): boolean {
  return workerBaseVersion === storedVersion;
}

export function nextSessionVersion(stored: number) {
  return (stored || 0) + 1;
}

export function sessionExpired(expiresHint?: number | null, nowSec = Date.now() / 1000) {
  return typeof expiresHint === "number" && expiresHint > 0 && expiresHint < nowSec;
}

export function applySessionUpdate(
  account: Pick<Account, "id" | "sessionVersion" | "platform"> & {
    expiresHint?: number | null;
  },
  write: SessionWrite,
  now = new Date(),
): SessionDecision {
  const stored = account.sessionVersion || 0;
  if (!canWriteSession(stored, write.baseVersion)) {
    return {
      ok: false,
      code: "STALE_SESSION_UPDATE",
      error: `STALE_SESSION_UPDATE: stored=${stored} worker_base=${write.baseVersion}`,
    };
  }
  const inspected = inspectSession(write.stateJson, account.platform as Platform);
  if (!inspected.ok) {
    return { ok: false, code: "SESSION_INVALID", error: inspected.reason };
  }
  if (sessionExpired(inspected.expiresAt)) {
    return { ok: false, code: "SESSION_EXPIRED", error: "session cookies expired" };
  }
  return {
    ok: true,
    sessionVersion: write.nextVersion || nextSessionVersion(stored),
    lastRefreshAt: now.toISOString(),
  };
}

export function sessionPatch(decision: Extract<SessionDecision, { ok: true }>, expiresHint?: number) {
  return {
    sessionVersion: decision.sessionVersion,
    lastRefreshAt: decision.lastRefreshAt,
    lastValidatedAt: decision.lastRefreshAt,
    expiresHint: expiresHint ?? null,
  };
}
