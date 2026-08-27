import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { startFakeRedis } from "./fake-redis.mjs";

function runChild(url, jobId, worker) {
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
        const { coordSetNx, coordIncr, resetCoordForTests } = await import("./src/lib/coord.ts");
        resetCoordForTests();
        const won = await coordSetNx("job-claim:" + ${JSON.stringify(jobId)}, ${JSON.stringify(worker)}, 8000);
        if (!won) { console.log("LOSE"); process.exit(0); }
        const fence = await coordIncr("job-fence:" + ${JSON.stringify(jobId)}, 8000);
        console.log("WIN " + fence);
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

test("multi-process-job-claim: two workers, one atomic claim + fencing token", async () => {
  const redis = await startFakeRedis();
  try {
    const results = await Promise.all([
      runChild(redis.url, "job-42", "w1"),
      runChild(redis.url, "job-42", "w2"),
      runChild(redis.url, "job-42", "w3"),
    ]);
    const wins = results.filter((r) => r.out.includes("WIN"));
    const losses = results.filter((r) => r.out.includes("LOSE"));
    assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
    assert.equal(wins.length, 1, JSON.stringify(results.map((r) => r.out)));
    assert.equal(losses.length, 2);
    assert.match(wins[0].out, /WIN 1/);
  } finally {
    await redis.close();
  }
});
