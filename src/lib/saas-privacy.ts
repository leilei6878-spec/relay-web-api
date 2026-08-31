import { effectiveCommercialEnv } from "./commercial-config";
import { getSql, type Sql } from "./db";
import { retentionPolicy } from "./data-retention";
import { sha256 } from "./saas-crypto";
import { uid } from "./utils";

type DbLike = Pick<Sql, "query">;

function database(db?: DbLike) {
  return db || getSql();
}

function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return value == null ? null : String(value);
}

function jsonBytes(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export async function listTenantPrivacyRequests(tenantId: string, db?: DbLike) {
  const sql = await database(db);
  return sql.query<Record<string, unknown>>(
    `select id,tenant_id,requested_by,kind,status,due_at,snapshot_sha256,blocked_reason,
            requested_at,cancelled_at,completed_at,updated_at
       from relay_privacy_requests where tenant_id=$1
      order by requested_at desc,id desc limit 100`,
    [tenantId],
  );
}

async function tenantExportSections(tenantId: string, userId: string, sql: DbLike) {
  const rows = await sql.query<{ sections: Record<string, Record<string, unknown>[]> | string }>(
    `select jsonb_build_object(
      'subject',coalesce((select jsonb_agg(to_jsonb(x)) from (
        select u.id,u.email,u.name,u.status,u.email_verified_at,u.mfa_enabled,u.last_login_at,u.created_at,u.updated_at
          from relay_saas_users u join relay_tenant_memberships m on m.user_id=u.id
         where u.id=$2 and m.tenant_id=$1
      ) x),'[]'::jsonb),
      'tenant',coalesce((select jsonb_agg(to_jsonb(x)) from (
        select id,slug,name,status,plan_id,billing_email,currency,balance_minor,reserved_minor,
               included_balance_minor,included_reserved_minor,credit_limit_minor,monthly_budget_minor,
               current_period_start,current_period_end,pending_plan_id,plan_change_effective_at,created_at,updated_at
          from relay_tenants where id=$1
      ) x),'[]'::jsonb),
      'members',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (
        select u.id,u.email,u.name,u.status as user_status,m.role,m.status as membership_status,m.created_at,m.updated_at
          from relay_tenant_memberships m join relay_saas_users u on u.id=m.user_id where m.tenant_id=$1
      ) x),'[]'::jsonb),
      'invitations',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (
        select id,email,role,invited_by,expires_at,accepted_at,revoked_at,revoked_by,
               last_sent_at,send_count,created_at,updated_at
          from relay_tenant_invites where tenant_id=$1
      ) x),'[]'::jsonb),
      'sessions',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (
        select id,tenant_id,ip_address,user_agent,expires_at,last_seen_at,mfa_verified_at,
               revoked_at,revoked_reason,revoked_by_session_id,created_at
          from relay_saas_sessions where tenant_id=$1 and user_id=$2
      ) x),'[]'::jsonb),
      'apiKeys',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (
        select id,name,key_prefix,key_hint,enabled,scopes,model_allowlist,requests_per_minute,concurrency_limit,
               daily_request_limit,monthly_spend_limit_minor,expires_at,last_used_at,created_by,created_at,revoked_at,
               previous_key_expires_at,rotated_at,rotation_count,updated_at
          from relay_tenant_api_keys where tenant_id=$1
      ) x),'[]'::jsonb),
      'orders',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (
        select id,type,status,currency,amount_minor,payment_provider,description,created_by,created_at,paid_at,
               expires_at,refunded_minor,tax_minor,gross_minor,refunded_tax_minor,refunded_gross_minor,updated_at
          from relay_orders where tenant_id=$1
      ) x),'[]'::jsonb),
      'billingTransactions',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (
        select id,order_id,request_id,kind,currency,amount_minor,balance_after_minor,description,created_at
          from relay_billing_transactions where tenant_id=$1
      ) x),'[]'::jsonb),
      'billingEntries',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (
        select id,transaction_id,account_code,amount_minor,currency,created_at
          from relay_billing_entries where tenant_id=$1
      ) x),'[]'::jsonb),
      'usageCharges',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (
        select id,api_key_id,request_id,provider,model,capability,price_book_id,prompt_tokens,completion_tokens,images,
               reserved_minor,reserved_included_minor,charged_minor,charged_included_minor,status,created_at,settled_at
          from relay_usage_charges where tenant_id=$1
      ) x),'[]'::jsonb),
      'planPeriods',coalesce((select jsonb_agg(to_jsonb(x) order by x.period_start,x.id) from (
        select id,plan_id,period_start,period_end,currency,monthly_fee_minor,included_credit_minor,
               expired_credit_minor,transaction_id,status,plan_snapshot,created_at
          from relay_plan_periods where tenant_id=$1
      ) x),'[]'::jsonb),
      'legalAcceptances',coalesce((select jsonb_agg(to_jsonb(x) order by x.accepted_at,x.id) from (
        select id,user_id,terms_version,privacy_version,bundle_sha256,acceptance_method,accepted_at
          from relay_legal_acceptances where tenant_id=$1
      ) x),'[]'::jsonb),
      'tenantAudit',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (
        select id,actor_user_id,actor_role,operation_id,action,target_type,target_id,outcome,error_code,request_id,detail,created_at
          from relay_tenant_audit_events where tenant_id=$1
      ) x),'[]'::jsonb),
      'privacyRequests',coalesce((select jsonb_agg(to_jsonb(x) order by x.requested_at,x.id) from (
        select id,requested_by,kind,status,due_at,snapshot_sha256,blocked_reason,requested_at,cancelled_at,completed_at,updated_at
          from relay_privacy_requests where tenant_id=$1
      ) x),'[]'::jsonb),
      'privacyEvents',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from (
        select id,request_id,actor_user_id,event_type,payload_sha256,detail,created_at
          from relay_privacy_request_events where tenant_id=$1
      ) x),'[]'::jsonb)
    ) as sections`,
    [tenantId, userId],
  );
  const sections = typeof rows[0]?.sections === "string" ? JSON.parse(rows[0].sections) : rows[0]?.sections;
  if (!sections?.subject?.length || !sections?.tenant?.length) throw new Error("PRIVACY_EXPORT_SCOPE_NOT_FOUND");
  return sections;
}

export async function createTenantDataExport(
  tenantId: string,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
  db?: DbLike,
) {
  const sql = await database(db);
  const effective = env === process.env ? await effectiveCommercialEnv(env, sql) : env;
  const requestId = uid();
  const generatedAt = new Date().toISOString();
  const sections = await tenantExportSections(tenantId, userId, sql);
  const payload = {
    schema: "relay-tenant-export-v1",
    requestId,
    generatedAt,
    tenantId,
    sections,
    retention: retentionPolicy(effective),
    exclusions: [
      "password, session, API-key and verification token hashes",
      "MFA secrets and recovery-code hashes",
      "payment provider secrets, Checkout URLs and raw provider references",
      "network HMAC evidence and encrypted provider result payloads",
    ],
  };
  const bytes = jsonBytes(payload);
  const maximum = Math.max(1, Math.min(250, Number(effective.RELAY_PRIVACY_EXPORT_MAX_MIB || 50))) * 1024 * 1024;
  if (bytes.byteLength > maximum) throw new Error("PRIVACY_EXPORT_TOO_LARGE");
  const digest = sha256(bytes.toString("utf8"));
  const rows = await sql.query<Record<string, unknown>>(
    `with request as (
       insert into relay_privacy_requests
        (id,tenant_id,requested_by,kind,status,due_at,snapshot_sha256,requested_at,completed_at,updated_at)
       values ($1,$2,$3,'tenant_export','completed',now(),$4,now(),now(),now()) returning *
     ), event as (
       insert into relay_privacy_request_events
        (id,request_id,tenant_id,actor_user_id,event_type,payload_sha256,detail,created_at)
       select $5,id,tenant_id,requested_by,'exported',snapshot_sha256,$6::jsonb,now() from request
     ) select id,kind,status,due_at,snapshot_sha256,requested_at,completed_at from request`,
    [requestId, tenantId, userId, digest, uid(), JSON.stringify({ schema: payload.schema, bytes: bytes.byteLength })],
  );
  return { payload, bytes, sha256: digest, request: rows[0] };
}

function closureGraceDays(env: NodeJS.ProcessEnv) {
  const value = Number(env.RELAY_TENANT_CLOSURE_GRACE_DAYS || 7);
  return Number.isFinite(value) ? Math.max(1, Math.min(30, Math.floor(value))) : 7;
}

export async function requestTenantClosure(
  tenantId: string,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
  db?: DbLike,
) {
  const sql = await database(db);
  const effective = env === process.env ? await effectiveCommercialEnv(env, sql) : env;
  const graceDays = closureGraceDays(effective);
  const requestId = uid();
  const rows = await sql.query<Record<string, unknown>>(
    `with inserted as (
       insert into relay_privacy_requests
        (id,tenant_id,requested_by,kind,status,due_at,requested_at,updated_at)
       values ($1,$2,$3,'tenant_closure','requested',now()+($4::text||' days')::interval,now(),now())
       on conflict do nothing returning *
     ), event as (
       insert into relay_privacy_request_events
        (id,request_id,tenant_id,actor_user_id,event_type,detail,created_at)
       select $5,id,tenant_id,requested_by,'requested',$6::jsonb,now() from inserted
     )
     select * from inserted
     union all
     select * from relay_privacy_requests
      where tenant_id=$2 and kind='tenant_closure' and status in ('requested','blocked')
        and not exists (select 1 from inserted)
     limit 1`,
    [requestId, tenantId, userId, graceDays, uid(), JSON.stringify({ graceDays })],
  );
  if (!rows[0]) throw new Error("PRIVACY_CLOSURE_REQUEST_FAILED");
  return rows[0];
}

export async function cancelTenantClosure(tenantId: string, userId: string, requestId: string, db?: DbLike) {
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>(
    `with cancelled as (
       update relay_privacy_requests
          set status='cancelled',cancelled_at=now(),blocked_reason=null,updated_at=now()
        where id=$1 and tenant_id=$2 and kind='tenant_closure'
          and status in ('requested','blocked') returning *
     ), event as (
       insert into relay_privacy_request_events
        (id,request_id,tenant_id,actor_user_id,event_type,detail,created_at)
       select $4,id,tenant_id,$3,'cancelled','{}'::jsonb,now() from cancelled
     ) select * from cancelled`,
    [requestId, tenantId, userId, uid()],
  );
  if (!rows[0]) throw new Error("PRIVACY_CLOSURE_NOT_CANCELABLE");
  return rows[0];
}

type ClosureBlocker = { code: string; detail: string };

export async function tenantClosureBlockers(tenantId: string, db?: DbLike): Promise<ClosureBlocker[]> {
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>(
    `select t.balance_minor,t.reserved_minor,t.included_balance_minor,t.included_reserved_minor,
            (select count(*)::int from relay_usage_charges c where c.tenant_id=t.id and c.status='reserved') as reserved_charges,
            (select count(*)::int from relay_orders o where o.tenant_id=t.id and o.status in ('pending','checkout_open','awaiting_payment')) as open_orders,
            (select count(*)::int from relay_payment_refunds r where r.tenant_id=t.id and r.status in ('pending','settlement_pending')) as open_refunds,
            (select count(*)::int from relay_payment_disputes d where d.tenant_id=t.id and d.status not in ('won','lost','warning_closed')) as open_disputes
       from relay_tenants t where t.id=$1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return [{ code: "TENANT_NOT_FOUND", detail: "tenant does not exist" }];
  const blockers: ClosureBlocker[] = [];
  const balances = ["balance_minor", "reserved_minor", "included_balance_minor", "included_reserved_minor"];
  if (balances.some((key) => Number(row[key] || 0) !== 0)) blockers.push({ code: "BALANCE_NOT_ZERO", detail: "cash, included credit and reservations must be zero" });
  if (Number(row.reserved_charges || 0)) blockers.push({ code: "USAGE_RESERVATION_OPEN", detail: `${row.reserved_charges} usage reservation(s)` });
  if (Number(row.open_orders || 0)) blockers.push({ code: "PAYMENT_ORDER_OPEN", detail: `${row.open_orders} payment order(s)` });
  if (Number(row.open_refunds || 0)) blockers.push({ code: "REFUND_OPEN", detail: `${row.open_refunds} refund(s)` });
  if (Number(row.open_disputes || 0)) blockers.push({ code: "DISPUTE_OPEN", detail: `${row.open_disputes} dispute(s)` });
  return blockers;
}

async function completeTenantClosure(requestId: string, db?: DbLike) {
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>(
    `with locked_request as (
       select * from relay_privacy_requests
        where id=$1 and kind='tenant_closure' and status in ('requested','blocked') and due_at<=now()
        for update
     ), locked_tenant as (
       select t.* from relay_tenants t join locked_request r on r.tenant_id=t.id for update
     ), candidate as (
       select r.*,
         case
           when t.balance_minor<>0 or t.reserved_minor<>0 or t.included_balance_minor<>0 or t.included_reserved_minor<>0 then 'BALANCE_NOT_ZERO'
           when exists (select 1 from relay_usage_charges c where c.tenant_id=t.id and c.status='reserved') then 'USAGE_RESERVATION_OPEN'
           when exists (select 1 from relay_orders o where o.tenant_id=t.id and o.status in ('pending','checkout_open','awaiting_payment')) then 'PAYMENT_ORDER_OPEN'
           when exists (select 1 from relay_payment_refunds f where f.tenant_id=t.id and f.status in ('pending','settlement_pending')) then 'REFUND_OPEN'
           when exists (select 1 from relay_payment_disputes d where d.tenant_id=t.id and d.status not in ('won','lost','warning_closed')) then 'DISPUTE_OPEN'
           else null
         end as effective_blocker
       from locked_request r join locked_tenant t on t.id=r.tenant_id
     ), blocked as (
       update relay_privacy_requests p
          set status='blocked',blocked_reason=c.effective_blocker,updated_at=now()
         from candidate c
        where p.id=c.id and c.effective_blocker is not null
          and (c.status='requested' or c.blocked_reason is distinct from c.effective_blocker)
       returning p.*
     ), blocked_event as (
       insert into relay_privacy_request_events
        (id,request_id,tenant_id,actor_user_id,event_type,detail,created_at)
       select $2,id,tenant_id,null,'blocked',jsonb_build_object('reason',blocked_reason),now() from blocked
     ), closed_tenant as (
       update relay_tenants t set status='closed',slug='closed-'||t.id,
         name='Closed tenant '||left(t.id,8),billing_email='closed+'||t.id||'@invalid.local',
         pending_plan_id=null,plan_change_effective_at=null,
         extra=jsonb_build_object('closedAt',now()::text,'privacyRequestId',$1::text),updated_at=now()
        from candidate c where t.id=c.tenant_id and c.effective_blocker is null
       returning t.id
     ), revoked_keys as (
       update relay_tenant_api_keys k set enabled=false,revoked_at=coalesce(revoked_at,now()),
         previous_key_hash=null,previous_key_expires_at=null,updated_at=now()
        from closed_tenant t where k.tenant_id=t.id and (k.enabled or k.revoked_at is null) returning k.id
     ), revoked_sessions as (
       update relay_saas_sessions s set revoked_at=coalesce(revoked_at,now()),
         revoked_reason=case when revoked_at is null then 'tenant_closed' else revoked_reason end
        from closed_tenant t where s.tenant_id=t.id and s.revoked_at is null returning s.id
     ), affected_users as (
       select m.user_id from relay_tenant_memberships m join closed_tenant t on t.id=m.tenant_id
     ), released_ownership as (
       delete from relay_tenant_ownership o using closed_tenant t where o.tenant_id=t.id returning o.tenant_id
     ), closed_memberships as (
       update relay_tenant_memberships m set status='disabled',updated_at=now()
        from closed_tenant t,(select count(*) from released_ownership) barrier
        where m.tenant_id=t.id returning m.user_id
     ), exclusive_users as (
       select a.user_id from affected_users a
        where not exists (
          select 1 from relay_tenant_memberships m join relay_tenants t on t.id=m.tenant_id
           where m.user_id=a.user_id and m.tenant_id<>(select id from closed_tenant)
             and m.status='active' and t.status in ('trial','active')
        )
     ), closed_users as (
       update relay_saas_users u set email='closed+'||u.id||'@invalid.local',
         email_normalized='closed+'||u.id||'@invalid.local',name='[CLOSED]',password_hash='!closed:'||u.id,
         status='closed',mfa_enabled=false,mfa_secret_ciphertext=null,recovery_codes_hash=null,
         mfa_pending_secret_ciphertext=null,mfa_pending_expires_at=null,updated_at=now()
        from exclusive_users e where u.id=e.user_id returning u.id
     ), consumed_verifications as (
       update relay_saas_verifications v set consumed_at=coalesce(consumed_at,now())
        from closed_users u where v.user_id=u.id and v.consumed_at is null returning v.id
     ), scrubbed_email as (
       update relay_email_deliveries d set status=case when d.status in ('delivered','expired','superseded') then d.status else 'superseded' end,
         payload_ciphertext='[PRIVACY_CLOSED]',error_code='PRIVACY_TENANT_CLOSED',updated_at=now()
        from closed_users u where d.dedupe_key like '%'||u.id||'%' returning d.id
     ), scrubbed_invite_email as (
       update relay_email_deliveries d set status=case when d.status in ('delivered','expired','superseded') then d.status else 'superseded' end,
         payload_ciphertext='[PRIVACY_CLOSED]',error_code='PRIVACY_TENANT_CLOSED',updated_at=now()
        from closed_tenant t where d.dedupe_key like 'tenant-invite:'||t.id||':%' returning d.id
     ), scrubbed_invites as (
       update relay_tenant_invites i set email='closed+'||i.id||'@invalid.local',
         email_normalized='closed+'||i.id||'@invalid.local',token_hash='closed:'||i.id,
         accepted_at=case when revoked_at is null then coalesce(accepted_at,now()) else accepted_at end,
         updated_at=now()
        from closed_tenant t where i.tenant_id=t.id returning i.id
     ), scrubbed_usage as (
       update relay_usage_charges c set extra=coalesce(c.extra,'{}'::jsonb)-'providerResultCiphertext'
        from closed_tenant t where c.tenant_id=t.id and c.extra ? 'providerResultCiphertext' returning c.id
     ), scrubbed_orders as (
       update relay_orders o set checkout_url=null,updated_at=now()
        from closed_tenant t where o.tenant_id=t.id and o.checkout_url is not null returning o.id
     ), completed as (
       update relay_privacy_requests p set status='completed',completed_at=now(),blocked_reason=null,updated_at=now()
        from candidate c join closed_tenant t on t.id=c.tenant_id where p.id=c.id returning p.*
     ), completed_event as (
       insert into relay_privacy_request_events
        (id,request_id,tenant_id,actor_user_id,event_type,detail,created_at)
       select $3,id,tenant_id,null,'completed',jsonb_build_object(
         'keysRevoked',(select count(*) from revoked_keys),
         'sessionsRevoked',(select count(*) from revoked_sessions),
         'ownershipReleased',(select count(*) from released_ownership),
         'usersPseudonymized',(select count(*) from closed_users),
         'emailsScrubbed',(select count(*) from scrubbed_email)+(select count(*) from scrubbed_invite_email),
         'invitesScrubbed',(select count(*) from scrubbed_invites),
         'usagePayloadsScrubbed',(select count(*) from scrubbed_usage),
         'checkoutUrlsScrubbed',(select count(*) from scrubbed_orders),
         'verificationsConsumed',(select count(*) from consumed_verifications)
       ),now() from completed
     )
     select * from completed
     union all select * from blocked
     union all select p.* from relay_privacy_requests p join candidate c on c.id=p.id
       where not exists (select 1 from completed) and not exists (select 1 from blocked)
     limit 1`,
    [requestId, uid(), uid()],
  );
  return rows[0] || null;
}

export async function processDueTenantClosures(db?: DbLike) {
  const sql = await database(db);
  const due = await sql.query<{ id: string; tenant_id: string }>(
    `select id,tenant_id from relay_privacy_requests
      where kind='tenant_closure' and status in ('requested','blocked') and due_at<=now()
      order by due_at,id limit 100`,
  );
  let completed = 0;
  let blocked = 0;
  for (const request of due) {
    const result = await completeTenantClosure(request.id, sql);
    if (String(result?.status || "") === "completed") completed += 1;
    else if (String(result?.status || "") === "blocked") blocked += 1;
  }
  return { examined: due.length, completed, blocked };
}

export function privacyExportFilename(tenantId: string, generatedAt: string) {
  return `relay-tenant-${tenantId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}-${generatedAt.slice(0, 10)}.json`;
}

export function privacyRequestPublicShape(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status),
    dueAt: iso(row.due_at),
    requestedAt: iso(row.requested_at),
    cancelledAt: iso(row.cancelled_at),
    completedAt: iso(row.completed_at),
    blockedReason: row.blocked_reason ? String(row.blocked_reason) : null,
    snapshotSha256: row.snapshot_sha256 ? String(row.snapshot_sha256) : null,
  };
}
