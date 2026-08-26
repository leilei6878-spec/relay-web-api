import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeRedis } from "../../scripts/fake-redis.mjs";

test("redis coord uses atomic SET NX / INCR / COMPAREDEL against a real RESP server", async () => {
  const redis = await startFakeRedis();
  process.env.REDIS_URL = redis.url;
  process.env.RELAY_SKIP_DB = "1";
  const { resetCoordForTests, coordSetNx, coordIncr, coordCompareDel, coordSet, coordGet, coordBackend } =
    await import("./coord.ts");
  resetCoordForTests();
  try {
    const a = await coordSetNx("job-claim:r1", "w1", 2000);
    const b = await coordSetNx("job-claim:r1", "w2", 2000);
    assert.equal(a, true);
    assert.equal(b, false);
    assert.equal(coordBackend(), "redis");
    const f1 = await coordIncr("job-fence:r1", 2000);
    const f2 = await coordIncr("job-fence:r1", 2000);
    assert.equal(f1, 1);
    assert.equal(f2, 2);
    await coordSet("lease:r1", "tok-a", 2000);
    assert.equal(await coordCompareDel("lease:r1", "tok-b"), false);
    assert.equal(await coordGet("lease:r1"), "tok-a");
    assert.equal(await coordCompareDel("lease:r1", "tok-a"), true);
    assert.equal(await coordGet("lease:r1"), null);
  } finally {
    delete process.env.REDIS_URL;
    resetCoordForTests();
    await redis.close();
  }
});
