import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

test("backup/restore: PGlite dump JSON snapshot into a new database and verify rows", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of ["0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql"]) {
    await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  }
  await pg.query(
    `insert into relay_accounts (id, platform, email, remark, status, created_at)
     values ('ac-backup', 'chatgpt', 'restore@test', '', 'healthy', now())`,
  );
  await pg.query(`insert into relay_requests (id, provider, model, status) values ('R-b', 'chatgpt', 'gpt-5.6', 'done')`);
  const dump = await pg.query("select id, email, status from relay_accounts where id=$1", ["ac-backup"]);
  assert.equal(dump.rows[0].email, "restore@test");

  const dir = join(tmpdir(), `relay-bak-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const snapshot = {
    accounts: dump.rows,
    requests: (await pg.query("select id, status from relay_requests")).rows,
  };
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(snapshot));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ at: new Date().toISOString(), files: ["snapshot.json"] }));

  const pg2 = new PGlite();
  await pg2.waitReady;
  for (const name of ["0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql"]) {
    await pg2.exec(await readFile(`migrations/${name}`, "utf8"));
  }
  const snap = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));
  for (const a of snap.accounts) {
    await pg2.query(
      `insert into relay_accounts (id, platform, email, remark, status, created_at)
       values ($1,'chatgpt',$2,'','healthy', now())`,
      [a.id, a.email],
    );
  }
  for (const r of snap.requests) {
    await pg2.query(`insert into relay_requests (id, provider, model, status) values ($1,'chatgpt','gpt-5.6',$2)`, [r.id, r.status]);
  }
  const got = await pg2.query("select email from relay_accounts where id=$1", ["ac-backup"]);
  assert.equal(got.rows[0].email, "restore@test");
  const req = await pg2.query("select status from relay_requests where id=$1", ["R-b"]);
  assert.equal(req.rows[0].status, "done");
  const ver = await pg2.query("select value from relay_meta where key='schema_version'");
  assert.equal(ver.rows[0].value, "4");
  rmSync(dir, { recursive: true, force: true });
});
