import { getSql, type Sql } from "./db";
import { coordIncr } from "./coord";
import { effectiveCommercialEnv } from "./commercial-config";
import { deliverEmailDeliveryNow, prepareEmailDelivery, type PreparedEmailDelivery } from "./email-outbox";
import { createTenantOwner } from "./saas-billing";
import { trustedClientIp as clientIp } from "./client-network";
import { prepareLegalAcceptance, userHasCurrentLegalAcceptance } from "./legal-documents";
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
type PublicEmailRequestOpts = {
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  deliverImmediately?: boolean;
  delay?: (ms: number) => Promise<void>;
};

async function database(db?: DbLike) {
  return db || getSql();
}

async function nonEnumeratingEmailResponse(startedAt: number, delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
  const minimumMs = 250 + Math.floor(Math.random() * 101);
  const remaining = minimumMs - (Date.now() - startedAt);
  if (remaining > 0) await delay(remaining);
  return { ok: true as const };
}

async function persistVerificationAndEmail(
  input: {
    userId: string;
    verificationId: string;
    verificationKind: "email" | "password_reset";
    tokenHash: string;
    expiresAt: string;
    delivery: PreparedEmailDelivery;
  },
  sql: DbLike,
) {
  const rows = await sql.query<{ id: string }>(
    `with retired_tokens as (
       update relay_saas_verifications set consumed_at=now()
        where user_id=$1 and kind=$2 and consumed_at is null
       returning id
     ), superseded_delivery as (
       update relay_email_deliveries set status='superseded',payload_ciphertext='[SUPERSEDED]',claim_expires_at=null,
         error_code='EMAIL_DELIVERY_SUPERSEDED',updated_at=now()
        where $8::text is not null and dedupe_key like $8
          and dedupe_key<>$7
          and status in ('pending','retrying','not_configured','sending')
       returning id
     ), verification as (
       insert into relay_saas_verifications(id,user_id,kind,token_hash,expires_at,created_at)
       select $3,$1,$2,$4,$5,now() from (select count(*) from retired_tokens) barrier
       returning id
     ), queued as (
       insert into relay_email_deliveries
        (id,dedupe_key,kind,status,attempts,recipient_hmac,payload_ciphertext,payload_sha256,next_attempt_at,expires_at,created_at,updated_at)
       select $6,$7,$9,'pending',0,$10,$11,$12,now(),$13,now(),now()
        from verification cross join (select count(*) from superseded_delivery) barrier
       returning id
     ) select id from queued`,
    [
      input.userId, input.verificationKind, input.verificationId, input.tokenHash, input.expiresAt,
      input.delivery.id, input.delivery.dedupeKey, input.delivery.supersedePattern, input.delivery.kind,
      input.delivery.recipientHmac, input.delivery.payloadCiphertext, input.delivery.payloadSha256,
      input.delivery.expiresAt,
    ],
  );
  if (rows[0]?.id !== input.delivery.id) throw new Error("EMAIL_OUTBOX_ENQUEUE_FAILED");
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

export async function createSaasSession(userId: string, tenantId: string, request: Request, db?: DbLike, mfaVerified = false, allowSuspended = false) {
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
      where m.user_id=$7 and m.tenant_id=$8 and m.status='active'
        and (t.status in ('trial','active') or ($10::boolean and t.status='suspended'))
     returning id`,
    [sessionId, sha256(token), sha256(csrf), clientIp(request), (request.headers.get("user-agent") || "").slice(0, 500), expiresAt, userId, tenantId, mfaVerified, allowSuspended],
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
  input: {
    tenantName: string; ownerName: string; email: string; password: string; currency?: string;
    legalAccepted?: boolean; termsVersion?: string; privacyVersion?: string; legalBundleSha256?: string;
  },
  request: Request,
  db?: DbLike,
  opts: { fetcher?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
) {
  if (!trustedSaasOrigin(request)) throw new Error("INVALID_ORIGIN");
  const ip = clientIp(request);
  const attempts = await coordIncr(`saas:register:${ip}:${new Date().toISOString().slice(0, 13)}`, 2 * 60 * 60_000);
  if (attempts > 10) throw new Error("REGISTRATION_RATE_LIMITED");
  const sql = await database(db);
  const env = opts.env || await effectiveCommercialEnv(process.env, sql);
  const verificationRequired = env.NODE_ENV === "production"
    ? env.RELAY_SAAS_EMAIL_VERIFICATION_REQUIRED !== "0"
    : env.RELAY_SAAS_EMAIL_VERIFICATION_REQUIRED === "1";
  const legalAcceptance = prepareLegalAcceptance({
    accepted: input.legalAccepted,
    termsVersion: input.termsVersion,
    privacyVersion: input.privacyVersion,
    bundleSha256: input.legalBundleSha256,
    method: "registration",
  }, request, env);
  const ownerInput = {
    tenantName: input.tenantName, ownerName: input.ownerName, email: input.email,
    password: input.password, currency: input.currency,
  };
  if (verificationRequired) {
    const ids = { tenantId: uid(), userId: uid() };
    const token = secureToken(32);
    const verificationId = uid();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const email = normalizeEmail(input.email);
    const publicUrl = env.RELAY_PUBLIC_URL?.replace(/\/$/, "") || new URL(request.url).origin;
    const delivery = prepareEmailDelivery({
      dedupeKey: `verify-email:${ids.userId}:${verificationId}`,
      supersedePrefix: `verify-email:${ids.userId}`,
      kind: "verify-email",
      to: email,
      expiresAt,
      payload: { template: "verify-email", to: email, tenant: input.tenantName.trim().slice(0, 120), link: `${publicUrl}/saas/verify?token=${encodeURIComponent(token)}` },
    }, env);
    const created = await createTenantOwner({
      ...ownerInput,
      userStatus: "pending_verification",
      emailVerified: false,
    }, sql, {
      ids,
      verification: { id: verificationId, tokenHash: sha256(token), expiresAt, delivery },
      legalAcceptance,
    });
    await deliverEmailDeliveryNow(delivery.id, sql, { env, fetcher: opts.fetcher });
    return {
      ...created,
      verificationRequired: true as const,
      sessionId: null,
      csrf: null,
      expiresAt: null,
      cookies: [] as string[],
    };
  }
  const created = await createTenantOwner({ ...ownerInput, userStatus: "active", emailVerified: true }, sql, { legalAcceptance });
  const session = await createSaasSession(created.userId, created.tenantId, request, sql);
  return { ...created, verificationRequired: false as const, ...session };
}

export async function sendSaasVerification(
  emailInput: string,
  request: Request,
  db?: DbLike,
  opts: PublicEmailRequestOpts = {},
) {
  const startedAt = Date.now();
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
  if (!users[0]) return nonEnumeratingEmailResponse(startedAt, opts.delay);
  try {
    const token = secureToken(32);
    const verificationId = uid();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const env = opts.env || await effectiveCommercialEnv(process.env, sql);
    const publicUrl = env.RELAY_PUBLIC_URL?.replace(/\/$/, "") || new URL(request.url).origin;
    const delivery = prepareEmailDelivery({
      dedupeKey: `verify-email:${users[0].id}:${verificationId}`,
      supersedePrefix: `verify-email:${users[0].id}`,
      kind: "verify-email",
      to: users[0].email,
      expiresAt,
      payload: { template: "verify-email", to: users[0].email, tenant: users[0].tenant_name, link: `${publicUrl}/saas/verify?token=${encodeURIComponent(token)}` },
    }, env);
    await persistVerificationAndEmail({
      userId: users[0].id, verificationId, verificationKind: "email", tokenHash: sha256(token), expiresAt, delivery,
    }, sql);
    if (opts.deliverImmediately) await deliverEmailDeliveryNow(delivery.id, sql, { env, fetcher: opts.fetcher });
  } catch {
    console.error(JSON.stringify({ source: "relay-email-request", kind: "verify-email", error: "EMAIL_OUTBOX_QUEUE_FAILED" }));
  }
  return nonEnumeratingEmailResponse(startedAt, opts.delay);
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
  opts: PublicEmailRequestOpts = {},
) {
  const startedAt = Date.now();
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
  if (!users[0]) return nonEnumeratingEmailResponse(startedAt, opts.delay);
  try {
    const token = secureToken(32);
    const verificationId = uid();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const env = opts.env || await effectiveCommercialEnv(process.env, sql);
    const publicUrl = env.RELAY_PUBLIC_URL?.replace(/\/$/, "") || new URL(request.url).origin;
    const delivery = prepareEmailDelivery({
      dedupeKey: `password-reset:${users[0].id}:${verificationId}`,
      supersedePrefix: `password-reset:${users[0].id}`,
      kind: "password-reset",
      to: users[0].email,
      expiresAt,
      payload: { template: "password-reset", to: users[0].email, link: `${publicUrl}/saas/reset?token=${encodeURIComponent(token)}` },
    }, env);
    await persistVerificationAndEmail({
      userId: users[0].id, verificationId, verificationKind: "password_reset", tokenHash: sha256(token), expiresAt, delivery,
    }, sql);
    if (opts.deliverImmediately) await deliverEmailDeliveryNow(delivery.id, sql, { env, fetcher: opts.fetcher });
  } catch {
    console.error(JSON.stringify({ source: "relay-email-request", kind: "password-reset", error: "EMAIL_OUTBOX_QUEUE_FAILED" }));
  }
  return nonEnumeratingEmailResponse(startedAt, opts.delay);
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
       update relay_saas_sessions s set revoked_at=now(),revoked_reason='password_reset'
        from updated u where s.user_id=u.id and s.revoked_at is null
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
      where m.user_id=$1 and m.status='active' and t.status in ('trial','active','suspended')
      order by case when t.status in ('trial','active') then 0 else 1 end,m.created_at asc`,
    [String(user.id)],
  );
  const membership = input.tenantId
    ? memberships.find((row) => row.tenant_id === input.tenantId)
    : memberships[0];
  if (!membership) throw new Error("NO_ACTIVE_TENANT");
  await sql.query("update relay_saas_users set last_login_at=now(),updated_at=now() where id=$1", [user.id]);
  const session = await createSaasSession(String(user.id), String(membership.tenant_id), request, sql, mfaVerified, true);
  const legalAcceptanceRequired = !await userHasCurrentLegalAcceptance(String(user.id), String(membership.tenant_id), process.env, sql);
  return {
    user: { id: String(user.id), email: String(user.email), name: String(user.name) },
    tenant: { id: String(membership.tenant_id), name: String(membership.tenant_name), status: String(membership.tenant_status), role: String(membership.role) as TenantRole },
    ...session,
    legalAcceptanceRequired,
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
  legalAcceptanceRequired: boolean;
};

export async function getSaasSession(request: Request, db?: DbLike, opts: { allowSuspended?: boolean } = {}): Promise<SaasSession | null> {
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
        and u.status='active' and m.status='active'
        and (t.status in ('trial','active') or ($2::boolean and t.status='suspended'))
      limit 1`,
    [sha256(token), opts.allowSuspended === true],
  );
  const row = rows[0];
  if (!row) return null;
  await sql.query(
    "update relay_saas_sessions set last_seen_at=now() where id=$1 and last_seen_at<now()-interval '5 minutes'",
    [row.session_id],
  );
  const legalAcceptanceRequired = !await userHasCurrentLegalAcceptance(String(row.user_id), String(row.tenant_id), process.env, sql);
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
    legalAcceptanceRequired,
  };
}

export async function assertSaasSession(
  request: Request,
  roles?: TenantRole[],
  opts: { requireCsrf?: boolean; requireMfa?: boolean; forceMfa?: boolean; requireLegal?: boolean; allowSuspended?: boolean } = {},
  db?: DbLike,
) {
  const session = await getSaasSession(request, db, { allowSuspended: opts.allowSuspended });
  if (!session) return { ok: false as const, status: 401, error: "SAAS_UNAUTHORIZED" };
  if (opts.requireLegal !== false && session.legalAcceptanceRequired) return { ok: false as const, status: 403, error: "LEGAL_RECONSENT_REQUIRED" };
  if (roles?.length && !roles.includes(session.role)) return { ok: false as const, status: 403, error: "SAAS_ROLE_REQUIRED" };
  if (opts.requireCsrf) {
    if (!trustedSaasOrigin(request)) return { ok: false as const, status: 403, error: "INVALID_ORIGIN" };
    const header = request.headers.get("x-csrf-token") || "";
    const cookieToken = cookie(request, SAAS_CSRF_COOKIE);
    if (!header || !cookieToken || header !== cookieToken || sha256(header) !== session.csrfHash) {
      return { ok: false as const, status: 403, error: "CSRF_INVALID" };
    }
  }
  if (opts.requireMfa || opts.forceMfa) {
    const env = await effectiveCommercialEnv(process.env, db);
    const required = opts.forceMfa || env.RELAY_REQUIRE_PRIVILEGED_SAAS_MFA === "1" || env.RELAY_COMMERCIAL_ENABLED === "1";
    const maxAgeHours = Math.max(1, Math.min(168, Number(env.RELAY_SAAS_MFA_MAX_AGE_HOURS || 24)));
    const verifiedAt = session.mfaVerifiedAt ? Date.parse(session.mfaVerifiedAt) : Number.NaN;
    if (required && (!session.mfaEnabled || !Number.isFinite(verifiedAt) || verifiedAt < Date.now() - maxAgeHours * 60 * 60_000)) {
      return { ok: false as const, status: 403, error: "MFA_STEP_UP_REQUIRED" };
    }
  }
  return { ok: true as const, session };
}

export async function logoutSaas(request: Request, db?: DbLike) {
  const token = cookie(request, SAAS_SESSION_COOKIE);
  if (token) {
    const sql = await database(db);
    await sql.query(
      "update relay_saas_sessions set revoked_at=now(),revoked_reason='logout' where token_hash=$1 and revoked_at is null",
      [sha256(token)],
    );
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
