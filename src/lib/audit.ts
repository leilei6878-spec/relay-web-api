import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { uid } from "./utils";

export type AuditRow = {
  id: string;
  at: string;
  action: string;
  detail: string;
};

const FILE = resolve("storage", "audit.json");

export async function audit(action: string, detail: string) {
  let rows: AuditRow[] = [];
  try {
    rows = (JSON.parse(await readFile(FILE, "utf8")) as { rows: AuditRow[] }).rows || [];
  } catch {
    rows = [];
  }
  const row: AuditRow = { id: uid(), at: new Date().toISOString(), action, detail };
  rows.unshift(row);
  rows = rows.slice(0, 500);
  await mkdir(resolve("storage"), { recursive: true });
  await writeFile(FILE, JSON.stringify({ rows }), "utf8");
  if (process.env.RELAY_SKIP_DB !== "1") {
    const { dbInsertAudit, safeDb } = await import("./relay-db");
    await safeDb(() => dbInsertAudit(row));
  }
}

export async function listAudit(limit = 50) {
  try {
    const rows = (JSON.parse(await readFile(FILE, "utf8")) as { rows: AuditRow[] }).rows || [];
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}
