import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { startFakeRedis } from "./fake-redis.mjs";

function runChild(url, key, id) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--import",
        "./scripts/register-ts-ext.mjs",
        "-e",
        `
        process.env.REDIS_URL = ${JSON.stringify(url)};
        process.env.RELAY_SKIP_DB = "1";
        const { coordSetNx, resetCoordForTests } = await import("./src/lib/coord.ts");
        resetCoordForTests();
        const ok = await coordSetNx(${JSON.stringify(key)}, ${JSON.stringify(id)}, 5000);
        console.log(ok ? "WIN" : "LOSE");
        process.exit(0);
        `,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("multi-process-lease: two Node processes, one SET NX winner", async () => {
  const redis = await startFakeRedis();
  try {
    const results = await Promise.all([
      runChild(redis.url, "acct:lease-1", "proc-a"),
      runChild(redis.url, "acct:lease-1", "proc-b"),
    ]);
    const wins = results.filter((r) => r.out.includes("WIN")).length;
    const losses = results.filter((r) => r.out.includes("LOSE")).length;
    assert.equal(results[0].code, 0, results[0].out);
    assert.equal(results[1].code, 0, results[1].out);
    assert.equal(wins, 1, JSON.stringify(results.map((r) => r.out)));
    assert.equal(losses, 1);
  } finally {
    await redis.close();
  }
});
