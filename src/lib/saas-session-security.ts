import { getSql, type Sql } from "./db";
import { coordSetNx } from "./coord";
import type { SaasSession } from "./saas-auth";
import { secureToken, sha256 } from "./saas-crypto";

type DbLike = Pick<Sql, "query">;

function database(db?: DbLike) {
  return db || getSql();
}

function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return value == null ? null : String(value);
}

export async function listUserSaasSessions(userId: string, currentSessionId: string, db?: DbLike) {
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>(
    `select s.id,s.tenant_id,t.name as tenant_name,t.status as tenant_status,s.ip_address,s.user_agent,
            s.expires_at,s.last_seen_at,s.mfa_verified_at,s.revoked_at,s.revoked_reason,s.created_at
       from relay_saas_sessions s join relay_tenants t on t.id=s.tenant_id
      where s.user_id=$1 and s.expires_at>now()-interval '30 days'
      order by (s.revoked_at is null and s.expires_at>now()) desc,s.last_seen_at desc,s.id`,
    [userId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    tenantName: String(row.tenant_name),
    tenantStatus: String(row.tenant_status),
    ipAddress: row.ip_address ? String(row.ip_address) : "unknown",
    userAgent: row.user_agent ? String(row.user_agent).slice(0, 500) : "unknown",
    createdAt: iso(row.created_at),
    lastSeenAt: iso(row.last_seen_at),
    expiresAt: iso(row.expires_at),
    mfaVerifiedAt: iso(row.mfa_verified_at),
    revokedAt: iso(row.revoked_at),
    revokedReason: row.revoked_reason ? String(row.revoked_reason) : null,
    current: String(row.id) === currentSessionId,
    active: !row.revoked_at && Date.parse(String(row.expires_at)) > Date.now(),
  }));
}

export async function revokeUserSaasSession(
  userId: string,
  currentSessionId: string,
  targetSessionId: string,
  db?: DbLike,
) {
  if (!targetSessionId || targetSessionId === currentSessionId) throw new Error("SESSION_CURRENT_REQUIRES_LOGOUT");
  const sql = await database(db);
  const rows = await sql.query<{ id: string }>(
    `update relay_saas_sessions set revoked_at=now(),revoked_reason='user_revoke',revoked_by_session_id=$2
      where id=$1 and user_id=$3 and revoked_at is null and expires_at>now() returning id`,
    [targetSessionId, currentSessionId, userId],
  );
  if (!rows[0]) throw new Error("SESSION_NOT_REVOCABLE");
  return { id: rows[0].id };
}

export async function revokeOtherSaasSessions(userId: string, currentSessionId: string, db?: DbLike) {
  const sql = await database(db);
  const rows = await sql.query<{ count: number }>(
    `with revoked as (
       update relay_saas_sessions set revoked_at=now(),revoked_reason='user_revoke_others',revoked_by_session_id=$2
        where user_id=$1 and id<>$2 and revoked_at is null and expires_at>now() returning id
     ) select count(*)::int as count from revoked`,
    [userId, currentSessionId],
  );
  return { revoked: Number(rows[0]?.count || 0) };
}

export async function rotateSaasRecoveryCodes(
  session: SaasSession,
  db?: DbLike,
  opts: { acquireLock?: (key: string) => Promise<boolean> } = {},
) {
  const sql = await database(db);
  const acquireLock = opts.acquireLock || ((key: string) => coordSetNx(key, session.sessionId, 30_000));
  let locked: boolean;
  try { locked = await acquireLock(`saas:mfa-recovery-rotate:${session.userId}`); }
  catch { throw new Error("MFA_RECOVERY_ROTATION_UNAVAILABLE"); }
  if (!locked) throw new Error("MFA_RECOVERY_ROTATION_IN_PROGRESS");
  const recoveryCodes = Array.from({ length: 8 }, () => secureToken(9));
  const rows = await sql.query<{ revoked: number }>(
    `with rotated as (
       update relay_saas_users set recovery_codes_hash=$1::jsonb,updated_at=now()
        where id=$2 and mfa_enabled=true returning id
     ), revoked as (
       update relay_saas_sessions s set revoked_at=now(),revoked_reason='mfa_recovery_rotation',revoked_by_session_id=$3
        from rotated u where s.user_id=u.id and s.id<>$3 and s.revoked_at is null and s.expires_at>now()
       returning s.id
     ) select (select count(*)::int from revoked) as revoked from rotated`,
    [JSON.stringify(recoveryCodes.map(sha256)), session.userId, session.sessionId],
  );
  if (!rows[0]) throw new Error("MFA_NOT_ENABLED");
  return { recoveryCodes, revokedSessions: Number(rows[0].revoked || 0) };
}
