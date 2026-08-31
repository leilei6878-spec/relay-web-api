import { getSql, type Sql } from "./db";
import { hashSaasPassword, normalizeEmail, secureToken, sha256 } from "./saas-crypto";
import type { TenantRole } from "./commercial-types";
import type { SaasSession } from "./saas-auth";
import { uid } from "./utils";
import { effectiveCommercialEnv } from "./commercial-config";
import { deliverEmailDeliveryNow, emailRecipientHmac, prepareEmailDelivery } from "./email-outbox";
import { prepareLegalAcceptance } from "./legal-documents";

type DbLike = Pick<Sql, "query">;
async function database(db?: DbLike) { return db || getSql(); }
const ROLES = new Set<TenantRole>(["owner", "admin", "billing", "developer", "viewer"]);

export async function listTenantMembers(tenantId: string, db?: DbLike) {
  const sql = await database(db);
  return sql.query<Record<string, unknown>>(
    `select u.id,u.email,u.name,u.status,u.mfa_enabled,m.role,m.status as membership_status,m.created_at,
            (o.user_id=m.user_id) as is_designated_owner
       from relay_tenant_memberships m join relay_saas_users u on u.id=m.user_id
       left join relay_tenant_ownership o on o.tenant_id=m.tenant_id
      where m.tenant_id=$1 order by m.created_at asc`,
    [tenantId],
  );
}

export async function inviteTenantMember(
  session: SaasSession,
  input: { email: string; role: TenantRole },
  opts: { db?: DbLike; fetcher?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
) {
  if (session.role !== "owner" && session.role !== "admin") throw new Error("SAAS_ROLE_REQUIRED");
  if (!ROLES.has(input.role)) throw new Error("INVALID_ROLE");
  if (input.role === "owner") throw new Error("OWNER_TRANSFER_REQUIRED");
  const email = normalizeEmail(input.email);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("INVALID_EMAIL");
  const sql = await database(opts.db);
  const token = secureToken(32);
  const id = uid();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60_000).toISOString();
  const env = opts.env || await effectiveCommercialEnv(process.env, sql);
  const publicUrl = env.RELAY_PUBLIC_URL?.replace(/\/$/, "") || "";
  const scope = `tenant-invite:${session.tenantId}:${emailRecipientHmac(email, env).slice(0, 32)}`;
  const delivery = prepareEmailDelivery({
    dedupeKey: `${scope}:${uid()}`,
    supersedePrefix: scope,
    kind: "tenant-invite",
    to: email,
    expiresAt,
    payload: { template: "tenant-invite", to: email, tenant: session.tenantName, role: input.role, link: `${publicUrl}/saas/invite?token=${encodeURIComponent(token)}` },
  }, env);
  const rows = await sql.query<{ invite_id: string; delivery_id: string }>(
    `with invite as (
       insert into relay_tenant_invites
        (id,tenant_id,email,email_normalized,role,token_hash,invited_by,expires_at,created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,now())
       on conflict (tenant_id,email_normalized) where accepted_at is null do update set
         role=excluded.role,token_hash=excluded.token_hash,invited_by=excluded.invited_by,
         expires_at=excluded.expires_at,created_at=now()
       returning id
     ), superseded_delivery as (
       update relay_email_deliveries set status='superseded',payload_ciphertext='[SUPERSEDED]',claim_expires_at=null,
         error_code='EMAIL_DELIVERY_SUPERSEDED',updated_at=now()
        where dedupe_key like $10 and dedupe_key<>$11
          and status in ('pending','retrying','not_configured','sending')
       returning id
     ), queued as (
       insert into relay_email_deliveries
        (id,dedupe_key,kind,status,attempts,recipient_hmac,payload_ciphertext,payload_sha256,next_attempt_at,expires_at,created_at,updated_at)
       select $9,$11,$12,'pending',0,$13,$14,$15,now(),$16,now(),now()
        from invite cross join (select count(*) from superseded_delivery) barrier
       returning id
     ) select invite.id as invite_id,queued.id as delivery_id from invite cross join queued`,
    [
      id, session.tenantId, input.email.trim(), email, input.role, sha256(token), session.userId, expiresAt,
      delivery.id, delivery.supersedePattern, delivery.dedupeKey, delivery.kind, delivery.recipientHmac,
      delivery.payloadCiphertext, delivery.payloadSha256, delivery.expiresAt,
    ],
  );
  if (!rows[0] || rows[0].delivery_id !== delivery.id) throw new Error("INVITE_CREATE_FAILED");
  const state = await deliverEmailDeliveryNow(delivery.id, sql, { env, fetcher: opts.fetcher });
  return { ok: true as const, inviteId: rows[0].invite_id, deliveryId: state.id, deliveryStatus: state.status };
}

export async function acceptTenantInvite(
  input: {
    token: string; name: string; password: string; legalAccepted?: boolean;
    termsVersion?: string; privacyVersion?: string; legalBundleSha256?: string;
  },
  request: Request,
  opts: { db?: DbLike; env?: NodeJS.ProcessEnv } = {},
) {
  const sql = await database(opts.db);
  const invites = await sql.query<Record<string, unknown>>(
    "select * from relay_tenant_invites where token_hash=$1 and accepted_at is null and expires_at > now()",
    [sha256(input.token)],
  );
  const invite = invites[0];
  if (!invite) throw new Error("INVITE_INVALID_OR_EXPIRED");
  const env = opts.env || await effectiveCommercialEnv(process.env, sql);
  const legalAcceptance = prepareLegalAcceptance({
    accepted: input.legalAccepted, termsVersion: input.termsVersion,
    privacyVersion: input.privacyVersion, bundleSha256: input.legalBundleSha256,
    method: "invite",
  }, request, env);
  const userId = uid();
  const rows = await sql.query<{ tenant_id: string; user_id: string }>(
    `with valid_invite as (
       select * from relay_tenant_invites
        where id=$1 and accepted_at is null and expires_at > now() for update
     ), inserted_user as (
       insert into relay_saas_users
         (id,email,email_normalized,name,password_hash,status,email_verified_at,created_at,updated_at)
       select $2,email,email_normalized,$3,$4,'active',now(),now(),now() from valid_invite
       on conflict (email_normalized) do nothing returning id
     ), selected_user as (
       select id,'active'::text as status from inserted_user
       union all
       select u.id,u.status from relay_saas_users u join valid_invite i on i.email_normalized=u.email_normalized
        where not exists (select 1 from inserted_user)
     ), legal_acceptance as (
       insert into relay_legal_acceptances
        (id,user_id,tenant_id,terms_version,privacy_version,bundle_sha256,ip_hmac,user_agent_hmac,acceptance_method,accepted_at)
       select $5,u.id,i.tenant_id,$6,$7,$8,$9,$10,$11,now()
         from valid_invite i join selected_user u on u.status='active' where $5::text is not null
       returning user_id,tenant_id
     ), legal_gate as (
       select u.id as user_id,i.tenant_id from valid_invite i join selected_user u on u.status='active'
        where $5::text is null
       union all
       select user_id,tenant_id from legal_acceptance
     ), membership as (
       insert into relay_tenant_memberships(tenant_id,user_id,role,status,created_at,updated_at)
       select i.tenant_id,u.id,i.role,'active',now(),now()
         from valid_invite i join selected_user u on u.status='active'
         join legal_gate g on g.user_id=u.id and g.tenant_id=i.tenant_id
       on conflict (tenant_id,user_id) do update set role=excluded.role,status='active',updated_at=now()
       returning tenant_id,user_id
     ), consumed as (
       update relay_tenant_invites i set accepted_at=now()
         from membership m where i.id=$1 returning m.tenant_id,m.user_id
     ) select tenant_id,user_id from consumed`,
    [
      invite.id, userId, input.name.trim().slice(0, 120), hashSaasPassword(input.password),
      legalAcceptance?.id || null, legalAcceptance?.termsVersion || null,
      legalAcceptance?.privacyVersion || null, legalAcceptance?.bundleSha256 || null,
      legalAcceptance?.ipHmac || null, legalAcceptance?.userAgentHmac || null,
      legalAcceptance?.method || null,
    ],
  );
  if (!rows[0]) throw new Error("INVITE_ACCEPT_FAILED_OR_USER_NOT_ACTIVE");
  return { ok: true as const, tenantId: String(rows[0].tenant_id), userId: String(rows[0].user_id) };
}

export async function updateTenantMemberRole(
  session: SaasSession,
  userId: string,
  role: TenantRole,
  status: "active" | "disabled",
  db?: DbLike,
) {
  if (session.role !== "owner" && session.role !== "admin") throw new Error("SAAS_ROLE_REQUIRED");
  if (!ROLES.has(role) || role === "owner" && session.role !== "owner") throw new Error("INVALID_ROLE");
  if (userId === session.userId && status !== "active") throw new Error("CANNOT_DISABLE_SELF");
  const sql = await database(db);
  const target = await sql.query<{ role: string }>(
    "select role from relay_tenant_memberships where tenant_id=$1 and user_id=$2",
    [session.tenantId, userId],
  );
  if (!target[0]) throw new Error("MEMBER_NOT_FOUND");
  if (role === "owner" && target[0].role !== "owner") throw new Error("OWNER_TRANSFER_REQUIRED");
  if (target[0].role === "owner" && (role !== "owner" || status !== "active")) {
    const owners = await sql.query<{ count: number }>(
      "select count(*)::int as count from relay_tenant_memberships where tenant_id=$1 and role='owner' and status='active'",
      [session.tenantId],
    );
    if (Number(owners[0]?.count || 0) <= 1) throw new Error("LAST_OWNER_REQUIRED");
  }
  await sql.query(
    "update relay_tenant_memberships set role=$3,status=$4,updated_at=now() where tenant_id=$1 and user_id=$2",
    [session.tenantId, userId, role, status],
  );
  return { ok: true as const };
}

export async function transferTenantOwnership(session: SaasSession, targetUserId: string, db?: DbLike) {
  if (session.role !== "owner") throw new Error("SAAS_OWNER_REQUIRED");
  if (!targetUserId || targetUserId === session.userId) throw new Error("OWNERSHIP_TARGET_INVALID");
  const sql = await database(db);
  const rows = await sql.query<{ previous_owner: string; new_owner: string }>(
    "select * from relay_transfer_tenant_ownership($1,$2,$3)",
    [session.tenantId, session.userId, targetUserId],
  );
  if (!rows[0]) throw new Error("OWNERSHIP_TRANSFER_FAILED");
  return { ok: true as const, previousOwnerId: rows[0].previous_owner, newOwnerId: rows[0].new_owner };
}
