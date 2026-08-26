import type { Sql } from "./db";

/**
 * SQL transport used by multi-process cluster tests.
 * Talks to `scripts/shared-pg.mjs` (one PGLite engine, many Gateway nodes).
 * Never used as a production fallback — production requires DATABASE_URL + pg.
 */
export function createHttpSql(base: string): Sql {
  const url = base.replace(/\/$/, "");
  const run = async <T>(text: string, params: unknown[]): Promise<T[]> => {
    const res = await fetch(`${url}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, params: params ?? [] }),
      signal: AbortSignal.timeout(4000),
    });
    const body = (await res.json()) as { rows?: T[]; error?: string };
    if (!res.ok) throw new Error(body.error || `sql-http ${res.status}`);
    return (body.rows || []) as T[];
  };
  const sql = (async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] || "";
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => run<T>(text, params);
  return sql;
}

export async function sqlHttpHealth(base: string) {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
