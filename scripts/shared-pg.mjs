import { createServer } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const dir = process.env.RELAY_PGLITE_DIR || "/tmp/relay-pgdata";
const port = Number(process.env.PG_HTTP_PORT || 19010);
const reset = process.env.RELAY_PG_RESET === "1";

if (reset) {
  await rm(dir, { recursive: true, force: true });
}
await mkdir(dir, { recursive: true });

const pg = new PGlite(dir);
await pg.waitReady;
await pg.exec(
  "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
);
const files = ["migrations/0001_relay.sql", "migrations/0002_relay_ops.sql", "migrations/0003_relay_production.sql"];
const doneRows = await pg.query("select name from _migrations");
const done = new Set(doneRows.rows.map((r) => r.name));
for (const path of files) {
  const name = path.split("/").pop();
  if (done.has(name)) continue;
  const sql = await readFile(path, "utf8");
  await pg.transaction(async (tx) => {
    await tx.exec(sql);
    await tx.query("insert into _migrations (name) values ($1)", [name]);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  try {
    if (req.url === "/health") {
      res.end(JSON.stringify({ ok: true, backend: "pglite-file" }));
      return;
    }
    if (req.method === "POST" && req.url === "/query") {
      const body = await readBody(req);
      const result = await pg.query(body.text, body.params || []);
      res.end(JSON.stringify({ rows: result.rows || [] }));
      return;
    }
    if (req.method === "POST" && req.url === "/exec") {
      const body = await readBody(req);
      await pg.exec(body.text);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ ok: true, url: `http://127.0.0.1:${port}`, dir }) + "\n");
});
