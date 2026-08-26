import assert from "node:assert/strict";
import { test } from "node:test";
import { coordSetNx, coordGet, coordDel, coordCompareDel, coordCompareExpire, coordSet, resetCoordForTests, withLock } from "./coord.ts";

test("lease race: only one NX winner", async () => {
  resetCoordForTests();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => coordSetNx("acct:1", `w${i}`, 2000)),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await coordSetNx("acct:1", "late", 2000), false);
  await coordDel("acct:1");
  assert.equal(await coordGet("acct:1"), null);
});

test("withLock serializes", async () => {
  resetCoordForTests();
  const order: number[] = [];
  await Promise.all([
    withLock("k", 2000, async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 40));
      order.push(2);
    }),
    withLock("k", 2000, async () => {
      order.push(3);
    }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("compare-and-delete is owner-safe", async () => {
  resetCoordForTests();
  await coordSet("lease:1", "tok-a", 2000);
  assert.equal(await coordCompareDel("lease:1", "tok-b"), false);
  assert.equal(await coordGet("lease:1"), "tok-a");
  assert.equal(await coordCompareDel("lease:1", "tok-a"), true);
  assert.equal(await coordGet("lease:1"), null);
});

test("compare-and-renew is owner-safe in memory", async () => {
  resetCoordForTests();
  await coordSet("lease:2", "tok-a", 200);
  assert.equal(await coordCompareExpire("lease:2", "tok-b", 2000), false);
  assert.equal(await coordCompareExpire("lease:2", "tok-a", 2000), true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await coordGet("lease:2"), "tok-a");
});
