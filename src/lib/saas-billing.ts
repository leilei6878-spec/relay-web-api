import { getSql, type Sql } from "./db";
import { hashSaasPassword, normalizeEmail } from "./saas-crypto";
import type { CommercialCapability, PriceBookRow, Tenant, UsageReservation } from "./commercial-types";
import { uid } from "./utils";
import { decryptSecretValue, encryptSecretValue } from "./secrets";

type DbLike = Pick<Sql, "query">;

async function database(db?: DbLike) {
  return db || getSql();
}

function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

function mapTenant(row: Record<string, unknown>): Tenant {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    status: row.status as Tenant["status"],
    planId: String(row.plan_id),
    billingEmail: String(row.billing_email),
    currency: String(row.currency),
    balanceMinor: Number(row.balance_minor || 0),
    reservedMinor: Number(row.reserved_minor || 0),
    creditLimitMinor: Number(row.credit_limit_minor || 0),
    monthlyBudgetMinor: Number(row.monthly_budget_minor || 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapPrice(row: Record<string, unknown>): PriceBookRow {
  return {
    id: String(row.id),
    version: Number(row.version),
    provider: String(row.provider),
    model: String(row.model),
    capability: row.capability as CommercialCapability,
    currency: String(row.currency),
    inputMicrosPerMillion: Number(row.input_micros_per_million || 0),
    outputMicrosPerMillion: Number(row.output_micros_per_million || 0),
    imagePriceMinor: Number(row.image_price_minor || 0),
    markupBasisPoints: Number(row.markup_basis_points || 0),
    effectiveFrom: iso(row.effective_from),
    effectiveTo: row.effective_to ? iso(row.effective_to) : null,
    status: row.status as PriceBookRow["status"],
  };
}

function slugify(value: string) {
  const base = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || `tenant-${uid().slice(0, 8)}`;
}

export async function createTenantOwner(
  input: { tenantName: string; ownerName: string; email: string; password: string; currency?: string; userStatus?: "active" | "pending_verification"; emailVerified?: boolean },
  db?: DbLike,
) {
  const sql = await database(db);
  const email = normalizeEmail(input.email);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("邮箱格式无效");
  const tenantName = input.tenantName.trim().slice(0, 120);
  const ownerName = input.ownerName.trim().slice(0, 120);
  if (!tenantName || !ownerName) throw new Error("企业名称和联系人不能为空");
  const tenantId = uid();
  const userId = uid();
  const slug = `${slugify(tenantName)}-${tenantId.slice(0, 6)}`;
  const passwordHash = hashSaasPassword(input.password);
  const currency = (input.currency || "USD").toUpperCase() === "CNY" ? "CNY" : "USD";
  const rows = await sql.query<Record<string, unknown>>(
    `with inserted_user as (
       insert into relay_saas_users
         (id,email,email_normalized,name,password_hash,status,email_verified_at,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$10,case when $11 then now() else null end,now(),now())
       returning id
     ), inserted_tenant as (
       insert into relay_tenants
         (id,slug,name,status,plan_id,billing_email,currency,created_at,updated_at)
       select $6,$7,$8,'trial','starter',$3,$9,now(),now() from inserted_user
       returning id
     ), inserted_membership as (
       insert into relay_tenant_memberships (tenant_id,user_id,role,status)
       select inserted_tenant.id,inserted_user.id,'owner','active'
         from inserted_tenant cross join inserted_user
       returning tenant_id,user_id
     )
     select tenant_id,user_id from inserted_membership`,
    [userId, input.email.trim(), email, ownerName, passwordHash, tenantId, slug, tenantName, currency, input.userStatus || "active", input.emailVerified !== false],
  );
  if (!rows[0]) throw new Error("租户创建失败");
  return { tenantId, userId, slug, email };
}

export async function getTenant(tenantId: string, db?: DbLike) {
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>("select * from relay_tenants where id=$1", [tenantId]);
  return rows[0] ? mapTenant(rows[0]) : null;
}

export async function activePrice(
  provider: string,
  model: string,
  capability: CommercialCapability,
  currency: string,
  db?: DbLike,
) {
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>(
    `select * from relay_price_book
      where provider=$1 and model=$2 and capability=$3 and currency=$4
        and status='active' and effective_from <= now()
        and (effective_to is null or effective_to > now())
      order by version desc limit 1`,
    [provider, model, capability, currency],
  );
  return rows[0] ? mapPrice(rows[0]) : null;
}

function ceilDiv(value: bigint, divisor: bigint) {
  return (value + divisor - 1n) / divisor;
}

export function calculateChargeMinor(
  price: PriceBookRow,
  usage: { promptTokens?: number; completionTokens?: number; images?: number },
) {
  let base = 0n;
  const prompt = BigInt(Math.max(0, Math.floor(usage.promptTokens || 0)));
  const completion = BigInt(Math.max(0, Math.floor(usage.completionTokens || 0)));
  const images = BigInt(Math.max(0, Math.floor(usage.images || 0)));
  // Rates are micro-currency per 1M tokens. 1 minor unit = 10,000 micro-units.
  const tokenMicros = ceilDiv(
    prompt * BigInt(price.inputMicrosPerMillion) + completion * BigInt(price.outputMicrosPerMillion),
    1_000_000n,
  );
  base += ceilDiv(tokenMicros, 10_000n);
  base += images * BigInt(price.imagePriceMinor);
  const marked = ceilDiv(base * BigInt(10_000 + price.markupBasisPoints), 10_000n);
  return Number(marked);
}

export async function postBalanceAdjustment(
  input: {
    tenantId: string;
    deltaMinor: number;
    kind: "recharge" | "adjustment" | "refund" | "charge" | "chargeback";
    idempotencyKey: string;
    description?: string;
    orderId?: string;
    requestId?: string;
    counterAccountCode?: "external_settlement" | "service_revenue" | "cash_refund" | "manual_adjustment" | "payment_dispute";
    allowNegative?: boolean;
    allowInactive?: boolean;
  },
  db?: DbLike,
) {
  const sql = await database(db);
  const delta = Math.trunc(input.deltaMinor);
  if (!delta) throw new Error("账务金额不能为 0");
  const existing = await sql.query<Record<string, unknown>>(
    "select * from relay_billing_transactions where tenant_id=$1 and idempotency_key=$2",
    [input.tenantId, input.idempotencyKey],
  );
  if (existing[0]) return { replay: true, transaction: existing[0] };
  const transactionId = uid();
  const walletEntryId = uid();
  const counterEntryId = uid();
  const counter = input.counterAccountCode || (delta > 0 ? "external_settlement" : "service_revenue");
  let rows: Record<string, unknown>[];
  try {
    rows = await sql.query<Record<string, unknown>>(
      `with locked as (
       select id,balance_minor,credit_limit_minor,currency
         from relay_tenants where id=$1 and ($13 or status in ('trial','active')) for update
     ), updated as (
       update relay_tenants t
          set balance_minor=t.balance_minor+$2,updated_at=now()
         from locked l
        where t.id=l.id and ($12 or l.balance_minor+l.credit_limit_minor+$2 >= 0)
       returning t.id,t.balance_minor,t.currency
     ), tx as (
       insert into relay_billing_transactions
         (id,tenant_id,order_id,request_id,kind,currency,amount_minor,balance_after_minor,idempotency_key,description,created_at)
       select $3,id,$4,$5,$6,currency,$2,balance_minor,$7,$8,now() from updated
       returning *
     ), wallet_entry as (
       insert into relay_billing_entries
         (id,transaction_id,tenant_id,account_code,amount_minor,currency,created_at)
       select $9,id,tenant_id,'tenant_wallet',$2,currency,now() from tx
     ), counter_entry as (
       insert into relay_billing_entries
         (id,transaction_id,tenant_id,account_code,amount_minor,currency,created_at)
       select $10,id,tenant_id,$11,-$2,currency,now() from tx
     )
       select * from tx`,
      [
        input.tenantId,
        delta,
        transactionId,
        input.orderId || null,
        input.requestId || null,
        input.kind,
        input.idempotencyKey,
        (input.description || "").slice(0, 500),
        walletEntryId,
        counterEntryId,
        counter,
        Boolean(input.allowNegative),
        Boolean(input.allowInactive),
      ],
    );
  } catch (error) {
    const replay = await sql.query<Record<string, unknown>>(
      "select * from relay_billing_transactions where tenant_id=$1 and idempotency_key=$2",
      [input.tenantId, input.idempotencyKey],
    );
    if (replay[0]) return { replay: true, transaction: replay[0] };
    throw error;
  }
  if (!rows[0]) throw new Error("余额不足、租户不可用或账务冲突");
  return { replay: false, transaction: rows[0] };
}

export async function reserveUsage(
  input: {
    tenantId: string;
    apiKeyId: string;
    requestId: string;
    provider: string;
    model: string;
    capability: CommercialCapability;
    estimatedPromptTokens?: number;
    estimatedCompletionTokens?: number;
    images?: number;
  },
  db?: DbLike,
): Promise<UsageReservation> {
  const sql = await database(db);
  await sql.query(
    `update relay_tenants set current_period_start=date_trunc('month',now()),
       current_period_end=date_trunc('month',now())+interval '1 month',updated_at=now()
      where id=$1 and current_period_end<=now()`,
    [input.tenantId],
  );
  const tenant = await getTenant(input.tenantId, sql);
  if (!tenant || !["trial", "active"].includes(tenant.status)) throw new Error("TENANT_SUSPENDED");
  const price = await activePrice(input.provider, input.model, input.capability, tenant.currency, sql);
  if (!price) throw new Error(`PRICE_NOT_CONFIGURED: ${input.provider}/${input.model}/${input.capability}`);
  const reservedMinor = calculateChargeMinor(price, {
    promptTokens: input.estimatedPromptTokens,
    completionTokens: input.estimatedCompletionTokens,
    images: input.images,
  });
  if (reservedMinor <= 0) throw new Error("PRICE_NOT_CONFIGURED: zero commercial price");
  const chargeId = uid();
  const rows = await sql.query<Record<string, unknown>>(
    `with locked as (
       select t.id,t.balance_minor,t.reserved_minor,t.credit_limit_minor,t.current_period_start,
              coalesce(nullif(t.monthly_budget_minor,0),nullif((p.limits->>'monthlySpendMinor')::bigint,0),0) as effective_monthly_budget
         from relay_tenants t join relay_plans p on p.id=t.plan_id
        where t.id=$1 and t.status in ('trial','active') for update of t
     ), period_spend as (
       select coalesce(sum(charged_minor),0)::bigint as charged
         from relay_usage_charges where tenant_id=$1 and status='settled'
           and created_at >= (select current_period_start from locked)
     ), charge as (
       insert into relay_usage_charges
         (id,tenant_id,api_key_id,request_id,provider,model,capability,price_book_id,reserved_minor,status,created_at)
       select $3,$1,$4,$5,$6,$7,$8,$9,$2,'reserved',now() from locked l,period_spend p
        where l.balance_minor+l.credit_limit_minor-l.reserved_minor >= $2
          and (l.effective_monthly_budget=0 or p.charged+l.reserved_minor+$2 <= l.effective_monthly_budget)
       on conflict (tenant_id,request_id) do nothing
       returning id
     ), updated as (
       update relay_tenants t
          set reserved_minor=t.reserved_minor+$2,updated_at=now()
         from charge where t.id=$1 returning t.id
     )
     select charge.id from charge join updated on true`,
    [input.tenantId, reservedMinor, chargeId, input.apiKeyId, input.requestId, input.provider, input.model, input.capability, price.id],
  );
  if (!rows[0]) {
    const replay = await sql.query<Record<string, unknown>>(
      "select id,reserved_minor,charged_minor,status,extra from relay_usage_charges where tenant_id=$1 and request_id=$2",
      [input.tenantId, input.requestId],
    );
    if (replay[0]) {
      const extra = replay[0].extra && typeof replay[0].extra === "object" ? replay[0].extra as Record<string, unknown> : {};
      return {
        chargeId: String(replay[0].id), tenantId: input.tenantId, requestId: input.requestId,
        reservedMinor: Number(replay[0].reserved_minor), price, replay: true,
        status: String(replay[0].status) as UsageReservation["status"],
        chargedMinor: Number(replay[0].charged_minor || 0),
        providerResultCiphertext: typeof extra.providerResultCiphertext === "string" ? extra.providerResultCiphertext : null,
      };
    }
    throw new Error("INSUFFICIENT_BALANCE_OR_BUDGET");
  }
  return { chargeId, tenantId: input.tenantId, requestId: input.requestId, reservedMinor, price, replay: false, status: "reserved", chargedMinor: 0, providerResultCiphertext: null };
}

export async function checkpointUsageProviderResult(
  chargeId: string,
  result: Record<string, unknown>,
  db?: DbLike,
) {
  const sql = await database(db);
  const ciphertext = encryptSecretValue(JSON.stringify(result));
  const rows = await sql.query<{ id: string }>(
    `update relay_usage_charges
        set extra=jsonb_set(jsonb_set(coalesce(extra,'{}'::jsonb),'{providerResultCiphertext}',to_jsonb($2::text),true),'{providerCompletedAt}',to_jsonb(now()::text),true)
      where id=$1 and status in ('reserved','settled') returning id`,
    [chargeId, ciphertext],
  );
  if (!rows[0]) throw new Error("CHARGE_CHECKPOINT_FAILED");
  return true;
}

export function decodeUsageProviderResult(ciphertext?: string | null) {
  if (!ciphertext) return null;
  try {
    const parsed = JSON.parse(decryptSecretValue(ciphertext));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function releaseUsageReservation(chargeId: string, reason: string, db?: DbLike) {
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>(
    `with charge as (
       update relay_usage_charges set status='released',settled_at=now(),extra=jsonb_set(extra,'{releaseReason}',to_jsonb($2::text),true)
        where id=$1 and status='reserved'
       returning tenant_id,reserved_minor
     ), tenant as (
       update relay_tenants t set reserved_minor=greatest(0,t.reserved_minor-c.reserved_minor),updated_at=now()
         from charge c where t.id=c.tenant_id returning t.id
     ) select * from charge`,
    [chargeId, reason.slice(0, 500)],
  );
  return Boolean(rows[0]);
}

export async function settleUsage(
  chargeId: string,
  usage: { promptTokens?: number; completionTokens?: number; images?: number },
  db?: DbLike,
) {
  const sql = await database(db);
  const rows = await sql.query<Record<string, unknown>>(
    `select c.*,p.version,p.provider as price_provider,p.model as price_model,p.capability as price_capability,
            p.currency as price_currency,p.input_micros_per_million,p.output_micros_per_million,
            p.image_price_minor,p.markup_basis_points,p.effective_from,p.effective_to,p.status as price_status
       from relay_usage_charges c join relay_price_book p on p.id=c.price_book_id where c.id=$1`,
    [chargeId],
  );
  const charge = rows[0];
  if (!charge) throw new Error("CHARGE_NOT_FOUND");
  if (charge.status === "settled") return { replay: true, chargedMinor: Number(charge.charged_minor || 0) };
  if (charge.status !== "reserved") throw new Error("CHARGE_NOT_RESERVED");
  const price = mapPrice({
    id: charge.price_book_id,
    version: charge.version,
    provider: charge.price_provider,
    model: charge.price_model,
    capability: charge.price_capability,
    currency: charge.price_currency,
    input_micros_per_million: charge.input_micros_per_million,
    output_micros_per_million: charge.output_micros_per_million,
    image_price_minor: charge.image_price_minor,
    markup_basis_points: charge.markup_basis_points,
    effective_from: charge.effective_from,
    effective_to: charge.effective_to,
    status: charge.price_status,
  });
  const chargedMinor = calculateChargeMinor(price, usage);
  const delta = -chargedMinor;
  const transactionId = uid();
  const idempotency = `usage:settle:${chargeId}`;
  const result = await sql.query<Record<string, unknown>>(
    `with locked as (
       select id,balance_minor,reserved_minor,credit_limit_minor,currency from relay_tenants where id=$1 for update
     ), updated as (
       update relay_tenants t
          set balance_minor=t.balance_minor-$2,reserved_minor=greatest(0,t.reserved_minor-$3),updated_at=now()
         from locked l where t.id=l.id and l.balance_minor+l.credit_limit_minor-l.reserved_minor+$3 >= $2
       returning t.id,t.balance_minor,t.currency
     ), settled as (
       update relay_usage_charges c set status='settled',charged_minor=$2,
         prompt_tokens=$4,completion_tokens=$5,images=$6,settled_at=now()
       from updated u where c.id=$7 and c.status='reserved' returning c.*
     ), tx as (
       insert into relay_billing_transactions
         (id,tenant_id,request_id,kind,currency,amount_minor,balance_after_minor,idempotency_key,description,created_at)
       select $8,$1,request_id,'charge',u.currency,$9,u.balance_minor,$10,'Official provider usage',now()
         from settled s join updated u on u.id=s.tenant_id
       returning *
     ), wallet_entry as (
       insert into relay_billing_entries(id,transaction_id,tenant_id,account_code,amount_minor,currency)
       select $11,id,tenant_id,'tenant_wallet',$9,currency from tx
     ), revenue_entry as (
       insert into relay_billing_entries(id,transaction_id,tenant_id,account_code,amount_minor,currency)
       select $12,id,tenant_id,'service_revenue',$2,currency from tx
     ) select * from tx`,
    [
      String(charge.tenant_id),
      chargedMinor,
      Number(charge.reserved_minor || 0),
      Math.max(0, Math.floor(usage.promptTokens || 0)),
      Math.max(0, Math.floor(usage.completionTokens || 0)),
      Math.max(0, Math.floor(usage.images || 0)),
      chargeId,
      transactionId,
      delta,
      idempotency,
      uid(),
      uid(),
    ],
  );
  if (!result[0]) {
    const latest = await sql.query<Record<string, unknown>>(
      "select status,charged_minor from relay_usage_charges where id=$1",
      [chargeId],
    );
    if (latest[0]?.status === "settled") {
      return { replay: true, chargedMinor: Number(latest[0].charged_minor || 0) };
    }
    throw new Error("SETTLEMENT_FAILED_OR_BALANCE_CHANGED");
  }
  return { replay: false, chargedMinor, transactionId };
}

export async function tenantBillingSummary(tenantId: string, db?: DbLike) {
  const sql = await database(db);
  const tenant = await getTenant(tenantId, sql);
  if (!tenant) return null;
  const transactions = await sql.query<Record<string, unknown>>(
    "select * from relay_billing_transactions where tenant_id=$1 order by created_at desc limit 100",
    [tenantId],
  );
  const charges = await sql.query<Record<string, unknown>>(
    "select * from relay_usage_charges where tenant_id=$1 order by created_at desc limit 100",
    [tenantId],
  );
  const orders = await sql.query<Record<string, unknown>>(
    `select id,tenant_id,type,status,currency,amount_minor,payment_provider,provider_reference,
            idempotency_key,description,created_at,paid_at,expires_at,checkout_expires_at,refunded_minor,
            tax_minor,gross_minor,refunded_tax_minor,refunded_gross_minor,
            case when status='checkout_open' and checkout_expires_at>now() then checkout_url else null end as checkout_url
       from relay_orders where tenant_id=$1 order by created_at desc limit 100`,
    [tenantId],
  );
  return { tenant, transactions, charges, orders };
}

export async function createRechargeOrder(
  input: { tenantId: string; amountMinor: number; idempotencyKey: string; description?: string },
  db?: DbLike,
) {
  const sql = await database(db);
  const amount = Math.max(100, Math.trunc(input.amountMinor));
  const id = uid();
  const rows = await sql.query<Record<string, unknown>>(
    `insert into relay_orders
      (id,tenant_id,type,status,currency,amount_minor,payment_provider,idempotency_key,description,created_at,expires_at)
     select $1,t.id,'recharge','pending',t.currency,$2,'manual',$3,$4,now(),now()+interval '24 hours'
       from relay_tenants t where t.id=$5 and t.status in ('trial','active')
     on conflict (tenant_id,idempotency_key) do nothing returning *`,
    [id, amount, input.idempotencyKey, (input.description || "Balance recharge").slice(0, 500), input.tenantId],
  );
  if (rows[0]) return { replay: false, order: rows[0] };
  const replay = await sql.query<Record<string, unknown>>(
    "select * from relay_orders where tenant_id=$1 and idempotency_key=$2",
    [input.tenantId, input.idempotencyKey],
  );
  if (!replay[0]) throw new Error("ORDER_CREATE_FAILED");
  return { replay: true, order: replay[0] };
}

export async function settleManualOrder(orderId: string, actor: string, db?: DbLike) {
  const sql = await database(db);
  const orders = await sql.query<Record<string, unknown>>("select * from relay_orders where id=$1", [orderId]);
  const order = orders[0];
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (order.status === "paid") return { replay: true, order };
  if (order.status !== "pending") throw new Error("ORDER_NOT_PENDING");
  await postBalanceAdjustment(
    {
      tenantId: String(order.tenant_id),
      deltaMinor: Number(order.amount_minor),
      kind: "recharge",
      idempotencyKey: `order:paid:${orderId}`,
      orderId,
      description: `Manual recharge approved by ${actor}`,
    },
    sql,
  );
  const paid = await sql.query<Record<string, unknown>>(
    "update relay_orders set status='paid',paid_at=coalesce(paid_at,now()),provider_reference=coalesce(provider_reference,$2) where id=$1 returning *",
    [orderId, `manual:${actor}`],
  );
  return { replay: false, order: paid[0] };
}

export async function publishPrice(
  input: {
    provider: string;
    model: string;
    capability: CommercialCapability;
    currency: string;
    inputMicrosPerMillion?: number;
    outputMicrosPerMillion?: number;
    imagePriceMinor?: number;
    markupBasisPoints?: number;
  },
  db?: DbLike,
) {
  const sql = await database(db);
  const id = uid();
  const rows = await sql.query<Record<string, unknown>>(
    `with current_version as (
       select coalesce(max(version),0)+1 as version from relay_price_book
        where provider=$1 and model=$2 and capability=$3 and currency=$4
     ), retired as (
       update relay_price_book set status='retired',effective_to=now()
        where provider=$1 and model=$2 and capability=$3 and currency=$4 and status='active'
     ), inserted as (
       insert into relay_price_book
         (id,version,provider,model,capability,currency,input_micros_per_million,
          output_micros_per_million,image_price_minor,markup_basis_points,effective_from,status)
       select $5,version,$1,$2,$3,$4,$6,$7,$8,$9,now(),'active' from current_version
       returning *
     ) select * from inserted`,
    [
      input.provider.trim(), input.model.trim(), input.capability, input.currency.toUpperCase(), id,
      Math.max(0, Math.trunc(input.inputMicrosPerMillion || 0)),
      Math.max(0, Math.trunc(input.outputMicrosPerMillion || 0)),
      Math.max(0, Math.trunc(input.imagePriceMinor || 0)),
      Math.max(0, Math.min(100_000, Math.trunc(input.markupBasisPoints || 0))),
    ],
  );
  if (!rows[0]) throw new Error("PRICE_PUBLISH_FAILED");
  return mapPrice(rows[0]);
}

export async function commercialAdminSnapshot(db?: DbLike) {
  const sql = await database(db);
  const [tenants, plans, prices, orders, transactions, alerts, paymentEvents, refunds, disputes] = await Promise.all([
    sql.query<Record<string, unknown>>("select * from relay_tenants order by created_at desc limit 500"),
    sql.query<Record<string, unknown>>("select * from relay_plans order by created_at asc"),
    sql.query<Record<string, unknown>>("select * from relay_price_book order by created_at desc limit 500"),
    sql.query<Record<string, unknown>>(
      `select id,tenant_id,type,status,currency,amount_minor,payment_provider,provider_reference,
              provider_session_id,provider_payment_intent,idempotency_key,description,created_by,
              created_at,paid_at,expires_at,checkout_expires_at,refunded_minor,tax_minor,gross_minor,
              refunded_tax_minor,refunded_gross_minor,updated_at
         from relay_orders order by created_at desc limit 500`,
    ),
    sql.query<Record<string, unknown>>("select * from relay_billing_transactions order by created_at desc limit 500"),
    sql.query<Record<string, unknown>>("select * from relay_alert_events order by last_seen_at desc limit 200"),
    sql.query<Record<string, unknown>>("select * from relay_payment_events order by created_at desc limit 500"),
    sql.query<Record<string, unknown>>("select * from relay_payment_refunds order by created_at desc limit 500"),
    sql.query<Record<string, unknown>>("select * from relay_payment_disputes order by created_at desc limit 500"),
  ]);
  return { tenants, plans, prices, orders, transactions, alerts, paymentEvents, refunds, disputes };
}
