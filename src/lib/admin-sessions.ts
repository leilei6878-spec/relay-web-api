import { getSql, type Sql } from "./db";
import { secureToken, sha256 } from "./saas-crypto";
import { uid } from "./utils";

type DbLike = Pick<Sql, "query">;

export const ADMIN_SESSION_PREFIX = "as-relay-";

export type AdminSessionRecord = {
  id: string;
  authMethod: "password" | "recovery_token" | "development";
  mfaVerified: boolean;
  expiresAt: string;
};

function database(db?: DbLike) {
  return db || getSql();
}

function sessionHours(env: NodeJS.ProcessEnv) {
  const value = Number(env.RELAY_ADMIN_SESSION_HOURS || 12);
  return Math.max(1, Math.min(24, Number.isFinite(value) ? Math.floor(value) : 12));
}

function requestFingerprint(request: Request) {
  const ip = (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown"
  ).split(",", 1)[0]!.trim().slice(0, 128) || "unknown";
  const userAgent = (request.headers.get("user-agent") || "unknown").slice(0, 1024);
  return { clientIpSha256: sha256(ip), userAgentSha256: sha256(userAgent) };
}

export async function createAdminSession(
  input: {
    request: Request;
    authMethod: AdminSessionRecord["authMethod"];
    mfaVerified: boolean;
    env?: NodeJS.ProcessEnv;
  },
  db?: DbLike,
) {
  const sql = await database(db);
  const env = input.env || process.env;
  const hours = sessionHours(env);
  const maxAge = hours * 3600;
  const token = `${ADMIN_SESSION_PREFIX}${secureToken(32)}`;
  const id = uid();
  const fingerprint = requestFingerprint(input.request);
  const rows = await sql.query<Record<string, unknown>>(
    `insert into relay_admin_sessions
       (id,token_sha256,auth_method,mfa_verified_at,client_ip_sha256,user_agent_sha256,created_at,last_seen_at,expires_at)
     values ($1,$2,$3,case when $4 then now() else null end,$5,$6,now(),now(),now()+($7::text||' seconds')::interval)
     returning id,auth_method,mfa_verified_at,expires_at`,
    [id, sha256(token), input.authMethod, input.mfaVerified, fingerprint.clientIpSha256, fingerprint.userAgentSha256, maxAge],
  );
  if (!rows[0]) throw new Error("ADMIN_SESSION_CREATE_FAILED");
  await sql.query(
    "insert into relay_audit(id,action,detail) values ($1,'admin.session.create',$2)",
    [uid(), JSON.stringify({ sessionId: id, authMethod: input.authMethod, mfaVerified: input.mfaVerified, expiresAt: rows[0].expires_at })],
  );
  await sql.query(
    "delete from relay_admin_sessions where expires_at < now()-interval '7 days' or revoked_at < now()-interval '7 days'",
  );
  return { token, maxAge, id, expiresAt: String(rows[0].expires_at) };
}

export async function findAdminSession(token: string, db?: DbLike): Promise<AdminSessionRecord | null> {
  if (!token.startsWith(ADMIN_SESSION_PREFIX) || token.length < ADMIN_SESSION_PREFIX.length + 32 || token.length > 256) return null;
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>(
    `select id,auth_method,mfa_verified_at,expires_at from relay_admin_sessions
      where token_sha256=$1 and revoked_at is null and expires_at>now() limit 1`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  await sql.query("update relay_admin_sessions set last_seen_at=now() where id=$1 and last_seen_at<now()-interval '5 minutes'", [row.id]);
  return {
    id: String(row.id),
    authMethod: String(row.auth_method) as AdminSessionRecord["authMethod"],
    mfaVerified: Boolean(row.mfa_verified_at),
    expiresAt: String(row.expires_at),
  };
}

export async function revokeAdminSession(token: string, db?: DbLike) {
  if (!token.startsWith(ADMIN_SESSION_PREFIX)) return false;
  const sql = await database(db);
  const rows = await sql.query<{ id: string }>(
    "update relay_admin_sessions set revoked_at=now() where token_sha256=$1 and revoked_at is null returning id",
    [sha256(token)],
  );
  if (rows[0]) await sql.query("insert into relay_audit(id,action,detail) values ($1,'admin.session.revoke',$2)", [uid(), JSON.stringify({ sessionId: rows[0].id })]);
  return Boolean(rows[0]);
}

export async function revokeAllAdminSessions(db?: DbLike) {
  const rows = await (await database(db)).query<{ id: string }>(
    "update relay_admin_sessions set revoked_at=now() where revoked_at is null and expires_at>now() returning id",
  );
  return rows.length;
}
