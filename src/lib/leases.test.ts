import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLease, issueLease } from "./leases.ts";

test("issueLease increments fencing token", () => {
  const a = issueLease("job-1", "w1", 0);
  const b = issueLease("job-1", "w1", a.fencingToken);
  assert.equal(b.fencingToken, a.fencingToken + 1);
  assert.notEqual(a.leaseId, b.leaseId);
  assert.notEqual(a.attemptId, b.attemptId);
});

test("stale worker result is rejected", () => {
  const lease = issueLease("job-1", "w1", 3);
  assert.equal(assertLease(lease, { leaseId: "nope", fencingToken: 4, attemptId: lease.attemptId }).ok, false);
  assert.equal(assertLease(lease, { leaseId: lease.leaseId, fencingToken: 1, attemptId: lease.attemptId }).ok, false);
  assert.equal(assertLease(undefined, { leaseId: lease.leaseId, fencingToken: 4 }).ok, false);
  assert.equal(assertLease(lease, { leaseId: lease.leaseId, fencingToken: 4, attemptId: lease.attemptId }).ok, true);
});
