import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("PG reclaim respects fresh heartbeats and never requeues submitted work", async () => {
  process.env.DATABASE_URL = "postgres://unused-for-pure-reclaim-test";
  const { reclaimDeadJobsWithDb } = await import("../src/lib/relay-db.ts");
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    create table relay_jobs (
      id text primary key,
      status text not null,
      worker_id text,
      attempt_id text,
      lease_id text,
      fencing_token integer,
      attempts integer not null default 0,
      timeout_ms integer not null,
      error text,
      fault text,
      started_at timestamptz,
      finished_at timestamptz,
      extra jsonb
    );
    create table relay_workers (
      name text primary key,
      last_beat timestamptz not null
    );
  `);
  await pg.exec(`
    insert into relay_workers(name,last_beat) values
      ('healthy-worker', now()),
      ('dead-worker', now() - interval '90 seconds');
  `);

  async function insertJob(id, worker, started, timeoutMs, extra) {
    await pg.query(
      `insert into relay_jobs
        (id,status,worker_id,attempt_id,lease_id,fencing_token,attempts,timeout_ms,started_at,extra)
       values ($1,'running',$2,'attempt-1','lease-1',1,1,$3,now() - $4::interval,$5::jsonb)`,
      [id, worker, timeoutMs, started, JSON.stringify({ id, accountId: `account-${id}`, timeoutMs, attempts: 1, ...extra })],
    );
  }

  await insertJob("healthy-long", "healthy-worker", "70 seconds", 180_000, {
    submissionState: "PREPARING",
    retrySafety: "SAFE",
  });
  await insertJob("dead-safe", "dead-worker", "70 seconds", 180_000, {
    submissionState: "INPUT_READY",
    retrySafety: "SAFE",
  });
  await insertJob("dead-submitted", "dead-worker", "70 seconds", 180_000, {
    submissionState: "SUBMITTED",
    submissionRank: 5,
    retrySafety: "UNSAFE",
    retrySafetyRank: 2,
  });
  await insertJob("timed-out", "healthy-worker", "50 seconds", 1_000, {
    submissionState: "INPUT_READY",
    retrySafety: "SAFE",
  });

  const db = {
    query: async (text, params = []) => (await pg.query(text, params)).rows,
  };
  const recovered = await reclaimDeadJobsWithDb(db, 60_000, 45_000, 3);
  assert.deepEqual(
    recovered.map((row) => [row.id, row.status]).sort(),
    [
      ["dead-safe", "queued"],
      ["dead-submitted", "error"],
      ["timed-out", "queued"],
    ],
  );

  const rows = await pg.query("select id,status,error from relay_jobs order by id");
  const byId = Object.fromEntries(rows.rows.map((row) => [row.id, row]));
  assert.equal(byId["healthy-long"].status, "running");
  assert.equal(byId["dead-safe"].status, "queued");
  assert.equal(byId["dead-submitted"].status, "error");
  assert.match(byId["dead-submitted"].error || "", /RESULT_UNCERTAIN/);
  assert.equal(byId["timed-out"].status, "queued");
  await pg.close();
});
