import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySubmissionCheckpoint,
  recoveryDisposition,
  resetSubmissionForRetry,
} from "./job-recovery.ts";

test("submission checkpoints are monotonic", () => {
  const submitting = applySubmissionCheckpoint({}, {
    submissionState: "SUBMITTING",
    retrySafety: "UNKNOWN",
  });
  const submitted = applySubmissionCheckpoint(submitting, {
    submissionState: "SUBMITTED",
    retrySafety: "UNSAFE",
  });
  const stale = applySubmissionCheckpoint(submitted, {
    submissionState: "INPUT_READY",
    retrySafety: "SAFE",
  });
  assert.equal(stale.submissionState, "SUBMITTED");
  assert.equal(stale.retrySafety, "UNSAFE");
  assert.ok(stale.submissionRank >= submitted.submissionRank);
  assert.ok(stale.retrySafetyRank >= submitted.retrySafetyRank);
});

test("only definitely pre-submit work may be requeued", () => {
  assert.equal(recoveryDisposition({ attempts: 1, submissionState: "INPUT_READY", retrySafety: "SAFE" }, 3), "requeue");
  assert.equal(recoveryDisposition({ attempts: 1, submissionState: "SUBMITTING", retrySafety: "UNKNOWN" }, 3), "uncertain");
  assert.equal(recoveryDisposition({ attempts: 1, submissionState: "SUBMITTED", retrySafety: "UNSAFE" }, 3), "uncertain");
  assert.equal(recoveryDisposition({ attempts: 3, submissionState: "INPUT_READY", retrySafety: "SAFE" }, 3), "dead");
});

test("a safe retry resets the state machine", () => {
  const next = resetSubmissionForRetry({ submissionState: "INPUT_READY", retrySafety: "SAFE" });
  assert.equal(next.submissionState, "PREPARING");
  assert.equal(next.retrySafety, "SAFE");
  assert.equal(next.submissionRank, 0);
  assert.equal(next.retrySafetyRank, 0);
});
