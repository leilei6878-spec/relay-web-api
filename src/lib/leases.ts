import { uid } from "./utils";

export type Lease = {
  leaseId: string;
  fencingToken: number;
  attemptId: string;
  workerId: string;
  jobId: string;
};

export function issueLease(jobId: string, workerId: string, previous = 0): Lease {
  return {
    leaseId: uid(),
    fencingToken: previous + 1,
    attemptId: uid(),
    workerId,
    jobId,
  };
}

export function assertLease(held: Lease | undefined, proof: { leaseId?: string; fencingToken?: number; attemptId?: string; workerId?: string } | undefined) {
  if (!held) return { ok: false as const, error: "STALE_LEASE: no active lease" };
  if (!proof?.leaseId || proof.leaseId !== held.leaseId) {
    return { ok: false as const, error: "STALE_LEASE: lease_id mismatch" };
  }
  if (proof.fencingToken !== held.fencingToken) {
    return { ok: false as const, error: "STALE_LEASE: fencing_token mismatch" };
  }
  if (proof.attemptId && proof.attemptId !== held.attemptId) {
    return { ok: false as const, error: "STALE_LEASE: attempt_id mismatch" };
  }
  return { ok: true as const };
}
