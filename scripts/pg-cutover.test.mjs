import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("postgres cutover: JSON fixture import then PG is SoT", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  const m1 = await readFile("migrations/0001_relay.sql", "utf8");
  const m2 = await readFile("migrations/0002_relay_ops.sql", "utf8");
  const m3 = await readFile("migrations/0003_relay_production.sql", "utf8");
  await pg.exec(m1);
  await pg.exec(m2);
  await pg.exec(m3);

  const fixture = {
    id: "job-from-json",
    requestId: "R-import",
    status: "queued",
    platform: "chatgpt",
    prompt: "hi",
    model: "gpt-5.6",
    timeoutMs: 1000,
    createdAt: new Date().toISOString(),
  };
  await pg.query(
    `insert into relay_jobs (id, request_id, status, platform, prompt, model, timeout_ms, extra)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [fixture.id, fixture.requestId, fixture.status, fixture.platform, fixture.prompt, fixture.model, fixture.timeoutMs, JSON.stringify(fixture)],
  );
  await pg.query(
    `insert into relay_requests (id, provider, model, status) values ($1,'chatgpt','gpt-5.6','queued')`,
    ["R-import"],
  );
  await pg.query(
    `insert into relay_attempts (id, request_id, job_id, status) values ('A1','R-import','job-from-json','pending')`,
  );

  const mutatedJson = { jobs: [{ id: "job-from-json", status: "cancelled", prompt: "tampered" }] };
  void mutatedJson;

  const rows = await pg.query("select status, prompt from relay_jobs where id=$1", ["job-from-json"]);
  assert.equal(rows.rows[0].status, "queued");
  assert.equal(rows.rows[0].prompt, "hi");

  const req = await pg.query("select status from relay_requests where id=$1", ["R-import"]);
  assert.equal(req.rows[0].status, "queued");
  const att = await pg.query("select count(*)::int as n from relay_attempts where request_id=$1", ["R-import"]);
  assert.equal(att.rows[0].n, 1);
});
