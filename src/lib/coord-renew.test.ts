import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeRedis } from "../../scripts/fake-redis.mjs";

test("compare-and-renew is atomic owner-safe against RESP server", async () => {
  const redis = await startFakeRedis();
  process.env.REDIS_URL = redis.url;
  const { resetCoordForTests, coordSet, coordGet, coordCompareExpire, coordCompareDel } = await import("./coord.ts");
  resetCoordForTests();
  try {
    await coordSet("lease:renew", "tok-a", 400);
    assert.equal(await coordCompareExpire("lease:renew", "tok-b", 2000), false);
    assert.equal(await coordGet("lease:renew"), "tok-a");
    assert.equal(await coordCompareExpire("lease:renew", "tok-a", 2000), true);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await coordGet("lease:renew"), "tok-a");
    assert.equal(await coordCompareDel("lease:renew", "tok-a"), true);
  } finally {
    delete process.env.REDIS_URL;
    resetCoordForTests();
    await redis.close();
  }
});

test("worker heartbeat must not steal a finished job's account lease", async () => {
  const { resetCoordForTests, coordSet, coordGet, renewJobLeases, releaseJobLeases } = await import("./coord.ts");
  resetCoordForTests();
  const jobId = "11111111-1111-4111-8111-111111111111";
  const nextJob = "22222222-2222-4222-8222-222222222222";
  await coordSet("account-lease:acc1", jobId, 2000);
  await coordSet(`job-claim:${jobId}`, jobId, 2000);
  await renewJobLeases(jobId, "acc1", 2000);
  assert.equal(await coordGet("account-lease:acc1"), jobId);
  await releaseJobLeases(jobId, "acc1", "worker-1");
  assert.equal(await coordGet("account-lease:acc1"), null);
  await coordSet("account-lease:acc1", "worker-1", 2000);
  await releaseJobLeases(jobId, "acc1", "worker-1");
  assert.equal(await coordGet("account-lease:acc1"), null);
  await coordSet("account-lease:acc1", nextJob, 2000);
  await releaseJobLeases(jobId, "acc1", "worker-1");
  assert.equal(await coordGet("account-lease:acc1"), nextJob);
});
