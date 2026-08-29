import { getSql, type Sql } from "./db";
import { coordIncr } from "./coord";
import { assertPublicCommercialWebhookUrl, effectiveCommercialEnv } from "./commercial-config";
import { createTenantOwner } from "./saas-billing";
import {
  generateTotpSecret,
  normalizeEmail,
  secureToken,
  sha256,
  verifySaasPassword,
  verifyTotp,
  hashSaasPassword,
} from "./saas-crypto";
import { decryptSecretValue, encryptSecretValue } from "./secrets";
import type { TenantRole } from "./commercial-types";
import { uid } from "./utils";

export const SAAS_SESSION_COOKIE = "relay_saas_session";
export const SAAS_CSRF_COOKIE = "relay_saas_csrf";

type DbLike = Pick<Sql, "query">;

async function database(db?: DbLike) {
  return db || getSql();
}

function cookie(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function secureRequest(request: Request) {
  const forwarded = (request.headers.get("x-forwarded-proto") || "").split(",")[0]?.trim();
  return new URL(request.url).protocol === "https:" || forwarded === "https";
}

function clientIp(request: Request) {
  const value = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for") || "unknown";
  return value.split(",")[0]!.trim().slice(0, 128);
}

export function trustedSaasOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const configured = (process.env.RELAY_PUBLIC_URL || "").replace(/\/$/, "");
  const forwardedProto = (request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "")).split(",")[0]?.trim();
  const forwardedHost = (request.headers.get("x-forwarded-host") || request.headers.get("host") || new URL(request.url).host).split(",")[0]?.trim();
  const requestOrigin = `${forwardedProto}://${forwardedHost}`;
  if (origin === requestOrigin || (configured && origin === configured)) return true;
  if (process.env.NODE_ENV !== "production") {
    return ["http://localhost:8080", "http://127.0.0.1:8080"].includes(origin);
  }
  return false;
}

function sessionCookie(name: string, value: string, maxAge: number, secure: boolean, httpOnly: boolean) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${maxAge}`, httpOnly ? "HttpOnly" : "", `SameSite=${httpOnly ? "Lax" : "Strict"}`]
    .filter(Boolean);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSaasCookies(request: Request) {
  const secure = secureRequest(request);
  return [
    sessionCookie(SAAS_SESSION_COOKIE, "", 0, secure, true),
    sessionCookie(SAAS_CSRF_COOKIE, "", 0, secure, false),
  ];
}

export async function createSaasSession(userId: string, tenantId: string, request: Request, db?: DbLike, mfaVerified = false) {
  const sql = await database(db);
  const token = secureToken(32);
  const csrf = secureToken(24);
  const sessionId = uid();
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const rows = await sql.query<{ id: string }>(
    `insert into relay_saas_sessions
      (id,user_id,tenant_id,token_hash,csrf_hash,ip_address,user_agent,expires_at,mfa_verified_at,last_seen_at,created_at)
     select $1,m.user_id,m.tenant_id,$2,$3,$4,$5,$6,case when $9 then now() else null end,now(),now()
       from relay_tenant_memberships m join relay_tenants t on t.id=m.tenant_id
      where m.user_id=$7 and m.tenant_id=$8 and m.status='active' and t.status in ('trial','active')
     returning id`,
    [sessionId, sha256(token), sha256(csrf), clientIp(request), (request.headers.get("user-agent") || "").slice(0, 500), expiresAt, userId, tenantId, mfaVerified],
  );
  if (!rows[0]) throw new Error("用户没有可用租户权限");
  const secure = secureRequest(request);
  return {
    sessionId,
    csrf,
    expiresAt,
    mfaVerified,
    cookies: [
      sessionCookie(SAAS_SESSION_COOKIE, token, 7 * 86_400, secure, true),
      sessionCookie(SAAS_CSRF_COOKIE, csrf, 7 * 86_400, secure, false),
    ],
  };
}

export async function registerSaasOwner(
  input: { tenantName: string; ownerName: string; email: string; password: string; currency?: string },
  request: Request,
  db?: DbLike,
  opts: { fetcher?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
) {
  if (!trustedSaasOrigin(request)) throw new Error("INVALID_ORIGIN");
  const ip = clientIp(request);
  const attempts = await coordIncr(`saas:register:${ip}:${new Date().toISOString().slice(0, 13)}`, 2 * 60 * 60_000);
  if (attempts > 10) throw new Error("REGISTRATION_RATE_LIMITED");
  const env = opts.env || await effectiveCommercialEnv(process.env, db);
  const verificationRequired = env.NODE_ENV === "production"
    ? env.RELAY_SAAS_EMAIL_VERIFICATION_REQUIRED !== "0"
    : env.RELAY_SAAS_EMAIL_VERIFICATION_REQUIRED === "1";
  const created = await createTenantOwner({
    ...input,
    userStatus: verificationRequired ? "pending_verification" : "active",
    emailVerified: !verificationRequired,
  }, db);
  if (verificationRequired) {
    await sendSaasVerification(created.email, request, db, opts);
    return {
      ...created,
      verificationRequired: true as const,
      sessionId: null,
      csrf: null,
      expiresAt: null,
      cookies: [] as string[],
    };
  }
  const session = await createSaasSession(created.userId, created.tenantId, request, db);
  return { ...created, verificationRequired: false as const, ...session };
}

export async function sendSaasVerification(
  emailInput: string,
  request: Request,
  db?: DbLike,
  opts: { fetcher?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
) {
  if (!trustedSaasOrigin(request)) throw new Error("INVALID_ORIGIN");
  const email = normalizeEmail(emailInput);
  const count = await coordIncr(`saas:verify-resend:${clientIp(request)}:${sha256(email).slice(0, 16)}`, 60 * 60_000);
  if (count > 5) throw new Error("VERIFICATION_RATE_LIMITED");
  const sql = await database(db);
  const users = await sql.query<{ id: string; email: string; tenant_name: string }>(
    `select u.id,u.email,t.name as tenant_name
       from relay_saas_users u
       join relay_tenant_memberships m on m.user_id=u.id
       join relay_tenants t on t.id=m.tenant_id
      where u.email_normalized=$1 and u.status='pending_verification' limit 1`,
    [email],
  );
  if (!users[0]) return { ok: true as const };
  const token = secureToken(32);
  await sql.query(
    `with expired as (
       update relay_saas_verifications set consumed_at=now()
        where user_id=$1 and kind='email' and consumed_at is null
     ) insert into relay_saas_verifications(id,user_id,kind,token_hash,expires_at,created_at)
       values ($2,$1,'email',$3,now()+interval '24 hours',now())`,
    [users[0].id, uid(), sha256(token)],
  );
  const env = opts.env || await effectiveCommercialEnv(process.env, db);
  const publicUrl = env.RELAY_PUBLIC_URL?.replace(/\/$/, "") || new URL(request.url).origin;
  const delivery = env.RELAY_EMAIL_WEBHOOK_URL?.trim();
  if (!delivery) throw new Error("EMAIL_DELIVERY_NOT_CONFIGURED");
  if (env.NODE_ENV === "production" && !opts.fetcher) await assertPublicCommercialWebhookUrl(delivery);
  const response = await (opts.fetcher || fetch)(delivery, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ template: "verify-email", to: users[0].email, tenant: users[0].tenant_name, link: `${publicUrl}/saas/verify?token=${encodeURIComponent(token)}` }),
  });
  if (!response.ok) throw new Error("EMAIL_DELIVERY_FAILED");
  return { ok: true as const };
}

export async function verifySaasEmail(token: string, request: Request, db?: DbLike) {
  if (!trustedSaasOrigin(request)) throw new Error("INVALID_ORIGIN");
  const sql = await database(db);
  const rows = await sql.query<{ user_id: string }>(
    `with consumed as (
       update relay_saas_verifications set consumed_at=now()
        where token_hash=$1 and kind='email' and consumed_at is null and expires_at > now()
       returning user_id
     ), activated as (
       update relay_saas_users u set status='active',email_verified_at=now(),updated_at=now()
        from consumed c where u.id=c.user_id returning u.id
     ) select id as user_id from activated`,
    [sha256(token)],
  );
  if (!rows[0]) throw new Error("VERIFICATION_INVALID_OR_EXPIRED");
  return { ok: true as const, userId: rows[0].user_id };
}

export async function requestSaasPasswordReset(
  emailInput: string,
  request: Request,
  db?: DbLike,
  opts: { fetcher?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
) {
  if (!trustedSaasOrigin(request)) throw new Error("INVALID_ORIGIN");
  const email = normalizeEmail(emailInput);
  const count = await coordIncr(`saas:reset:${clientIp(request)}:${sha256(email).slice(0, 16)}`, 60 * 60_000);
  if (count > 5) throw new Error("RESET_RATE_LIMITED");
  const sql = await database(db);
  const users = await sql.query<{ id: string; email: string }>(
    "select id,email from relay_saas_users where email_normalized=$1 and status in ('active','pending_verification') limit 1",
    [email],
  );
  // Do not reveal whether the address exists.
  if (!users[0]) return { ok: true as const };
  const token = secureToken(32);
  await sql.query(
    "insert into relay_saas_verifications(id,user_id,kind,token_hash,expires_at,created_at) values ($1,$2,'password_reset',$3,now()+interval '1 hour',now())",
    [uid(), users[0].id, sha256(token)],
  );
  const env = opts.env || await effectiveCommercialEnv(process.env, db);
  const delivery = env.RELAY_EMAIL_WEBHOOK_URL?.trim();
  if (!delivery) throw new Error("EMAIL_DELIVERY_NOT_CONFIGURED");
  if (env.NODE_ENV === "production" && !opts.fetcher) await assertPublicCommercialWebhookUrl(delivery);
  const publicUrl = env.RELAY_PUBLIC_URL?.replace(/\/$/, "") || new URL(request.url).origin;
  const response = await (opts.fetcher || fetch)(delivery, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ template: "password-reset", to: users[0].email, link: `${publicUrl}/saas/reset?token=${encodeURIComponent(token)}` }),
  });
  if (!response.ok) throw new Error("EMAIL_DELIVERY_FAILED");
  return { ok: true as const };
}

export async function resetSaasPassword(token: string, password: string, request: Request, db?: DbLike) {
  if (!trustedSaasOrigin(request)) throw new Error("INVALID_ORIGIN");
  const sql = await database(db);
  const rows = await sql.query<{ user_id: string }>(
    `with consumed as (
       update relay_saas_verifications set consumed_at=now()
        where token_hash=$1 and kind='password_reset' and consumed_at is null and expires_at > now()
       returning user_id
     ), updated as (
       update relay_saas_users u set password_hash=$2,status='active',email_verified_at=coalesce(email_verified_at,now()),updated_at=now()
        from consumed c where u.id=c.user_id returning u.id
     ), revoked as (
       update relay_saas_sessions s set revoked_at=now() from updated u where s.user_id=u.id and s.revoked_at is null
     ) select id as user_id from updated`,
    [sha256(token), hashSaasPassword(password)],
  );
  if (!rows[0]) throw new Error("RESET_INVALID_OR_EXPIRED");
  return { ok: true as const };
}

export async function loginSaas(
  input: { email: string; password: string; tenantId?: string; totp?: string; recoveryCode?: string },
  request: Request,
  db?: DbLike,
) {
  if (!trustedSaasOrigin(request)) throw new Error("INVALID_ORIGIN");
  const sql = await database(db);
  const email = normalizeEmail(input.email);
  const ip = clientIp(request);
  const key = `saas:login:${ip}:${sha256(email).slice(0, 16)}:${new Date().toISOString().slice(0, 13)}`;
  const attempts = await coordIncr(key, 2 * 60 * 60_000);
  if (attempts > 12) throw new Error("LOGIN_RATE_LIMITED");
  const users = await sql.query<Record<string, unknown>>(
    "select * from relay_saas_users where email_normalized=$1 and status='active' limit 1",
    [email],
  );
  const user = users[0];
  if (!user || !verifySaasPassword(input.password, String(user.password_hash || ""))) throw new Error("INVALID_CREDENTIALS");
  let mfaVerified = false;
  if (user.mfa_enabled) {
    const encrypted = String(user.mfa_secret_ciphertext || "");
    const totpOk = Boolean(encrypted && input.totp && verifyTotp(decryptSecretValue(encrypted), input.totp));
    let recoveryOk = false;
    if (!totpOk && input.recoveryCode?.trim()) {
      const recoveryHash = sha256(input.recoveryCode.trim());
      const consumed = await sql.query<{ id: string }>(
        `update relay_saas_users set recovery_codes_hash=coalesce(recovery_codes_hash,'[]'::jsonb)-$2,updated_at=now()
          where id=$1 and coalesce(recovery_codes_hash,'[]'::jsonb) ? $2 returning id`,
        [user.id, recoveryHash],
      );
      recoveryOk = Boolean(consumed[0]);
    }
    if (!totpOk && !recoveryOk) throw new Error("MFA_REQUIRED");
    mfaVerified = true;
  }
  const memberships = await sql.query<Record<string, unknown>>(
    `select m.*,t.name as tenant_name,t.status as tenant_status
       from relay_tenant_memberships m join relay_tenants t on t.id=m.tenant_id
      where m.user_id=$1 and m.status='active' and t.status in ('trial','active')
      order by m.created_at asc`,
    [String(user.id)],
  );
  const membership = input.tenantId
    ? memberships.find((row) => row.tenant_id === input.tenantId)
    : memberships[0];
  if (!membership) throw new Error("NO_ACTIVE_TENANT");
  await sql.query("update relay_saas_users set last_login_at=now(),updated_at=now() where id=$1", [user.id]);
  const session = await createSaasSession(String(user.id), String(membership.tenant_id), request, sql, mfaVerified);
  return {
    user: { id: String(user.id), email: String(user.email), name: String(user.name) },
    tenant: { id: String(membership.tenant_id), name: String(membership.tenant_name), role: String(membership.role) as TenantRole },
    ...session,
  };
}

export type SaasSession = {
  sessionId: string;
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  tenantName: string;
  tenantStatus: string;
  role: TenantRole;
  csrfHash: string;
  expiresAt: string;
  mfaVerified: boolean;
  mfaVerifiedAt: string | null;
  mfaEnabled: boolean;
};

export async function getSaasSession(request: Request, db?: DbLike): Promise<SaasSession | null> {
  const token = cookie(request, SAAS_SESSION_COOKIE);
  if (!token) return null;
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>(
    `select s.id as session_id,s.user_id,s.tenant_id,s.csrf_hash,s.expires_at,s.mfa_verified_at,
            u.email,u.name,u.mfa_enabled,t.name as tenant_name,t.status as tenant_status,m.role
       from relay_saas_sessions s
       join relay_saas_users u on u.id=s.user_id
       join relay_tenants t on t.id=s.tenant_id
       join relay_tenant_memberships m on m.tenant_id=s.tenant_id and m.user_id=s.user_id
      where s.token_hash=$1 and s.revoked_at is null and s.expires_at > now()
        and u.status='active' and m.status='active' and t.status in ('trial','active')
      limit 1`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    email: String(row.email),
    name: String(row.name),
    tenantName: String(row.tenant_name),
    tenantStatus: String(row.tenant_status),
    role: row.role as TenantRole,
    csrfHash: String(row.csrf_hash),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    mfaVerified: Boolean(row.mfa_verified_at),
    mfaVerifiedAt: row.mfa_verified_at ? (row.mfa_verified_at instanceof Date ? row.mfa_verified_at.toISOString() : String(row.mfa_verified_at)) : null,
    mfaEnabled: Boolean(row.mfa_enabled),
  };
}

export async function assertSaasSession(
  request: Request,
  roles?: TenantRole[],
  opts: { requireCsrf?: boolean; requireMfa?: boolean } = {},
  db?: DbLike,
) {
  const session = await getSaasSession(request, db);
  if (!session) return { ok: false as const, status: 401, error: "SAAS_UNAUTHORIZED" };
  if (roles?.length && !roles.includes(session.role)) return { ok: false as const, status: 403, error: "SAAS_ROLE_REQUIRED" };
  if (opts.requireCsrf) {
    if (!trustedSaasOrigin(request)) return { ok: false as const, status: 403, error: "INVALID_ORIGIN" };
    const header = request.headers.get("x-csrf-token") || "";
    const cookieToken = cookie(request, SAAS_CSRF_COOKIE);
    if (!header || !cookieToken || header !== cookieToken || sha256(header) !== session.csrfHash) {
      return { ok: false as const, status: 403, error: "CSRF_INVALID" };
    }
  }
  if (opts.requireMfa) {
    const env = await effectiveCommercialEnv(process.env, db);
    const required = env.RELAY_REQUIRE_PRIVILEGED_SAAS_MFA === "1" || env.RELAY_COMMERCIAL_ENABLED === "1";
    const maxAgeHours = Math.max(1, Math.min(168, Number(env.RELAY_SAAS_MFA_MAX_AGE_HOURS || 24)));
    const verifiedAt = session.mfaVerifiedAt ? Date.parse(session.mfaVerifiedAt) : Number.NaN;
    if (required && (!Number.isFinite(verifiedAt) || verifiedAt < Date.now() - maxAgeHours * 60 * 60_000)) {
      return { ok: false as const, status: 403, error: "MFA_STEP_UP_REQUIRED" };
    }
  }
  return { ok: true as const, session };
}

export async function logoutSaas(request: Request, db?: DbLike) {
  const token = cookie(request, SAAS_SESSION_COOKIE);
  if (token) {
    const sql = await database(db);
    await sql.query("update relay_saas_sessions set revoked_at=now() where token_hash=$1 and revoked_at is null", [sha256(token)]);
  }
  return clearSaasCookies(request);
}

export async function startSaasMfa(session: SaasSession, db?: DbLike) {
  const sql = await database(db);
  const secret = generateTotpSecret();
  await sql.query(
    "update relay_saas_users set mfa_secret_ciphertext=$1,mfa_enabled=false,updated_at=now() where id=$2",
    [encryptSecretValue(secret), session.userId],
  );
  const issuer = encodeURIComponent("Relay SaaS");
  const label = encodeURIComponent(`${session.tenantName}:${session.email}`);
  return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30` };
}

export async function confirmSaasMfa(session: SaasSession, code: string, db?: DbLike) {
  const sql = await database(db);
  const rows = await sql.query<{ mfa_secret_ciphertext: string }>(
    "select mfa_secret_ciphertext from relay_saas_users where id=$1",
    [session.userId],
  );
  const encrypted = rows[0]?.mfa_secret_ciphertext || "";
  if (!encrypted || !verifyTotp(decryptSecretValue(encrypted), code)) return { ok: false as const, error: "MFA_CODE_INVALID" };
  const recoveryCodes = Array.from({ length: 8 }, () => secureToken(9));
  await sql.query(
    `with enabled as (
       update relay_saas_users set mfa_enabled=true,recovery_codes_hash=$1::jsonb,updated_at=now() where id=$2 returning id
     ) update relay_saas_sessions s set mfa_verified_at=now(),last_seen_at=now()
        from enabled u where s.id=$3 and s.user_id=u.id and s.revoked_at is null`,
    [JSON.stringify(recoveryCodes.map(sha256)), session.userId, session.sessionId],
  );
  return { ok: true as const, recoveryCodes };
}
