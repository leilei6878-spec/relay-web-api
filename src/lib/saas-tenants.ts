import { getSql, type Sql } from "./db";

type DbLike = Pick<Sql, "query">;

export async function listUserSaasTenants(userId: string, db?: DbLike) {
  const sql = db || await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `select t.id,t.slug,t.name,t.status,t.plan_id,m.role,m.created_at
       from relay_tenant_memberships m join relay_tenants t on t.id=m.tenant_id
      where m.user_id=$1 and m.status='active' and t.status in ('trial','active','suspended')
      order by case when t.status in ('trial','active') then 0 else 1 end,m.created_at,t.id`,
    [userId],
  );
  return rows.map((row) => ({
    id: String(row.id), slug: String(row.slug), name: String(row.name), status: String(row.status),
    planId: String(row.plan_id), role: String(row.role), createdAt: row.created_at,
  }));
}
