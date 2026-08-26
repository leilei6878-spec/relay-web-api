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
