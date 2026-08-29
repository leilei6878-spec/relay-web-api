import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getSql, type Sql } from "./db";
import { commercialReadiness } from "./commercial-readiness";
import { postBalanceAdjustment } from "./saas-billing";
import { uid } from "./utils";

type DbLike = Pick<Sql, "query">;
type FetchLike = typeof fetch;

type StripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  created?: number;
  data: { object: Record<string, unknown> };
};

function dbOrDefault(db?: DbLike) {
  return db || getSql();
}

function safeInteger(value: unknown, name: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name}_INVALID`);
  return parsed;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringId(value: unknown) {
  if (typeof value === "string") return value;
  return String(objectValue(value).id || "");
}

function stripeConfig(env: NodeJS.ProcessEnv) {
  const key = env.STRIPE_SECRET_KEY?.trim() || "";
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || "";
  const publicUrl = (env.RELAY_PUBLIC_URL || "").trim().replace(/\/$/, "");
  if (env.RELAY_PAYMENT_PROVIDER !== "stripe") throw new Error("PAYMENT_PROVIDER_NOT_CONFIGURED");
  if (!key) throw new Error("STRIPE_SECRET_KEY_MISSING");
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET_MISSING");
  if (!publicUrl.startsWith("https://")) throw new Error("PAYMENT_PUBLIC_URL_INVALID");
  if (env.NODE_ENV === "production" && !/^(sk|rk)_live_/.test(key)) throw new Error("STRIPE_LIVE_KEY_REQUIRED");
  return { key, webhookSecret, publicUrl };
}

async function stripeRequest(
  path: string,
  init: { method?: "GET" | "POST"; form?: URLSearchParams; idempotencyKey?: string },
  env: NodeJS.ProcessEnv,
  fetcher: FetchLike,
) {
  const { key } = stripeConfig(env);
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (init.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  const response = await fetcher(`https://api.stripe.com/v1${path}`, {
    method: init.method || "POST",
    headers,
    body: init.form?.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = objectValue(body.error);
    const code = String(error.code || error.type || response.status);
    throw new Error(`STRIPE_API_ERROR:${code.slice(0, 80)}`);
  }
  return body;
}

export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  nowMs = Date.now(),
  toleranceSeconds = 300,
) {
  const pieces = signatureHeader.split(",").map((part) => part.trim().split("=", 2));
  const timestamp = Number(pieces.find(([key]) => key === "t")?.[1] || 0);
  const signatures = pieces.filter(([key]) => key === "v1").map(([, value]) => value || "");
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !signatures.length) throw new Error("STRIPE_SIGNATURE_INVALID");
  if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > toleranceSeconds) throw new Error("STRIPE_SIGNATURE_STALE");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  const valid = signatures.some((candidate) => {
    if (!/^[a-f0-9]{64}$/i.test(candidate)) return false;
    const supplied = Buffer.from(candidate, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (!valid) throw new Error("STRIPE_SIGNATURE_INVALID");
  return timestamp;
}

export function parseStripeWebhook(rawBody: string, signature: string, env: NodeJS.ProcessEnv = process.env) {
  if (Buffer.byteLength(rawBody, "utf8") > 1_000_000) throw new Error("STRIPE_WEBHOOK_TOO_LARGE");
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim() || "";
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET_MISSING");
  const signatureTimestamp = verifyStripeSignature(rawBody, signature, secret);
  const event = JSON.parse(rawBody) as StripeEvent;
  if (!event?.id?.startsWith("evt_") || !event.type || !event.data?.object) throw new Error("STRIPE_EVENT_INVALID");
  return {
    event,
    signatureTimestamp,
    payloadSha256: createHash("sha256").update(rawBody, "utf8").digest("hex"),
  };
}

export async function createStripeCheckout(
  input: { tenantId: string; amountMinor: number; idempotencyKey: string },
  options: { env?: NodeJS.ProcessEnv; db?: DbLike; fetcher?: FetchLike } = {},
) {
  const env = options.env || process.env;
  const sql = await dbOrDefault(options.db);
  const fetcher = options.fetcher || fetch;
  const { publicUrl } = stripeConfig(env);
  if (env.RELAY_COMMERCIAL_ENABLED !== "1") throw new Error("COMMERCIAL_NOT_ENABLED");
  const readiness = await commercialReadiness(env, sql);
  if (!readiness.ready) throw new Error(`COMMERCIAL_NOT_READY:${readiness.blockers.join("|")}`);
  const amount = safeInteger(input.amountMinor, "PAYMENT_AMOUNT");
  const maximum = Math.max(100, Number(env.RELAY_STRIPE_MAX_RECHARGE_MINOR || 1_000_000));
  if (amount < 100 || amount > maximum) throw new Error("PAYMENT_AMOUNT_OUT_OF_RANGE");
  const idempotencyKey = input.idempotencyKey.trim().slice(0, 200);
  if (!idempotencyKey) throw new Error("PAYMENT_IDEMPOTENCY_REQUIRED");
  const orderId = uid();
  const inserted = await sql.query<Record<string, unknown>>(
    `insert into relay_orders
      (id,tenant_id,type,status,currency,amount_minor,gross_minor,payment_provider,idempotency_key,description,created_at,updated_at,expires_at)
     select $1,t.id,'recharge','creating',t.currency,$2,$2,'stripe',$3,'Stripe Checkout recharge',now(),now(),now()+interval '24 hours'
       from relay_tenants t where t.id=$4 and t.status in ('trial','active') and t.currency in ('USD','CNY')
     on conflict (tenant_id,idempotency_key) do nothing returning *`,
    [orderId, amount, idempotencyKey, input.tenantId],
  );
  let order = inserted[0];
  if (!order) {
    const rows = await sql.query<Record<string, unknown>>(
      "select * from relay_orders where tenant_id=$1 and idempotency_key=$2",
      [input.tenantId, idempotencyKey],
    );
    order = rows[0];
    if (!order || order.payment_provider !== "stripe" || Number(order.amount_minor) !== amount) {
      throw new Error("PAYMENT_IDEMPOTENCY_CONFLICT");
    }
    if (order.checkout_url && order.status === "checkout_open") {
      return { replay: true, checkoutUrl: String(order.checkout_url), order: publicOrder(order) };
    }
  }
  if (!order) throw new Error("PAYMENT_ORDER_CREATE_FAILED");
  const tenants = await sql.query<Record<string, unknown>>(
    "select billing_email,currency from relay_tenants where id=$1",
    [input.tenantId],
  );
  const tenant = tenants[0];
  if (!tenant) throw new Error("PAYMENT_TENANT_NOT_FOUND");
  const currency = String(order.currency).toLowerCase();
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${publicUrl}/portal?checkout=success`);
  form.set("cancel_url", `${publicUrl}/portal?checkout=cancelled`);
  form.set("client_reference_id", String(order.id));
  form.set("customer_email", String(tenant.billing_email));
  form.set("metadata[order_id]", String(order.id));
  form.set("metadata[tenant_id]", input.tenantId);
  form.set("payment_intent_data[metadata][order_id]", String(order.id));
  form.set("payment_intent_data[metadata][tenant_id]", input.tenantId);
  if (env.RELAY_TAX_MODE === "stripe_automatic") {
    form.set("automatic_tax[enabled]", "true");
    form.set("billing_address_collection", "required");
  }
  form.set("line_items[0][price_data][currency]", currency);
  form.set("line_items[0][price_data][unit_amount]", String(amount));
  form.set("line_items[0][price_data][product_data][name]", "Relay API prepaid credit");
  form.set("line_items[0][quantity]", "1");
  try {
    const session = await stripeRequest("/checkout/sessions", { form, idempotencyKey: `relay-order:${String(order.id)}` }, env, fetcher);
    const sessionId = String(session.id || "");
    const checkoutUrl = String(session.url || "");
    const sessionSubtotal = safeInteger(session.amount_subtotal ?? session.amount_total, "STRIPE_SESSION_SUBTOTAL");
    if (!sessionId.startsWith("cs_") || !checkoutUrl.startsWith("https://checkout.stripe.com/") || sessionSubtotal !== amount || String(session.currency).toLowerCase() !== currency) {
      throw new Error("STRIPE_SESSION_MISMATCH");
    }
    const expiresAt = Number(session.expires_at || 0);
    const updated = await sql.query<Record<string, unknown>>(
      `update relay_orders set status='checkout_open',provider_reference=$2,provider_session_id=$2,
         checkout_url=$3,checkout_expires_at=to_timestamp($4),updated_at=now()
        where id=$1 and payment_provider='stripe' and status in ('creating','payment_failed','checkout_open') returning *`,
      [String(order.id), sessionId, checkoutUrl, expiresAt],
    );
    if (!updated[0]) throw new Error("PAYMENT_ORDER_UPDATE_FAILED");
    return { replay: false, checkoutUrl, order: publicOrder(updated[0]) };
  } catch (error) {
    await sql.query(
      "update relay_orders set status='payment_failed',updated_at=now() where id=$1 and provider_session_id is null and status='creating'",
      [String(order.id)],
    );
    throw error;
  }
}

function publicOrder(order: Record<string, unknown>) {
  return {
    id: String(order.id), status: String(order.status), currency: String(order.currency),
    amountMinor: Number(order.amount_minor), paymentProvider: String(order.payment_provider),
    taxMinor: Number(order.tax_minor || 0), grossMinor: Number(order.gross_minor || order.amount_minor || 0),
    providerReference: order.provider_reference ? String(order.provider_reference) : null,
    expiresAt: order.checkout_expires_at || order.expires_at || null,
  };
}

async function recordEvent(
  input: { event: StripeEvent; payloadSha256: string; signatureTimestamp: number },
  sql: DbLike,
) {
  const existing = await sql.query<Record<string, unknown>>(
    "select * from relay_payment_events where provider='stripe' and provider_event_id=$1",
    [input.event.id],
  );
  if (existing[0]) {
    if (existing[0].payload_sha256 !== input.payloadSha256) throw new Error("STRIPE_EVENT_PAYLOAD_CHANGED");
    await sql.query("update relay_payment_events set attempt_count=attempt_count+1,updated_at=now() where id=$1", [existing[0].id]);
    return { row: existing[0], replay: ["processed", "ignored"].includes(String(existing[0].status)) };
  }
  const rows = await sql.query<Record<string, unknown>>(
    `insert into relay_payment_events
      (id,provider,provider_event_id,event_type,livemode,status,payload_sha256,signature_timestamp,created_at,updated_at)
     values ($1,'stripe',$2,$3,$4,'received',$5,$6,now(),now()) returning *`,
    [uid(), input.event.id, input.event.type, Boolean(input.event.livemode), input.payloadSha256, input.signatureTimestamp],
  );
  return { row: rows[0]!, replay: false };
}

async function markEvent(sql: DbLike, eventId: string, status: "processed" | "ignored" | "failed", detail: { orderId?: string; amountMinor?: number; currency?: string; error?: string } = {}) {
  await sql.query(
    `update relay_payment_events set status=$2,order_id=coalesce($3,order_id),amount_minor=coalesce($4,amount_minor),
       currency=coalesce($5,currency),error=$6,processed_at=case when $2 in ('processed','ignored') then now() else processed_at end,updated_at=now()
      where id=$1`,
    [eventId, status, detail.orderId || null, detail.amountMinor ?? null, detail.currency || null, detail.error?.slice(0, 500) || null],
  );
}

async function postStripePaymentSettlement(
  input: { tenantId: string; orderId: string; paymentIntent: string; creditMinor: number; taxMinor: number; grossMinor: number },
  sql: DbLike,
) {
  if (input.creditMinor <= 0 || input.taxMinor < 0 || input.grossMinor !== input.creditMinor + input.taxMinor) throw new Error("STRIPE_PAYMENT_LEDGER_MISMATCH");
  const key = `stripe:payment:${input.paymentIntent}`;
  const existing = await sql.query<Record<string, unknown>>(
    "select * from relay_billing_transactions where tenant_id=$1 and idempotency_key=$2",
    [input.tenantId, key],
  );
  if (existing[0]) return { replay: true, transaction: existing[0] };
  const transactionId = uid();
  try {
    const rows = await sql.query<Record<string, unknown>>(
      `with locked as (
         select id,balance_minor,currency from relay_tenants where id=$1 for update
       ), updated as (
         update relay_tenants t set balance_minor=t.balance_minor+$2::bigint,updated_at=now()
          from locked l where t.id=l.id returning t.id,t.balance_minor,t.currency
       ), tx as (
         insert into relay_billing_transactions
          (id,tenant_id,order_id,kind,currency,amount_minor,balance_after_minor,idempotency_key,description,created_at,extra)
         select $5,id,$6,'recharge',currency,$2::bigint,balance_minor,$7,$8,now(),$12::jsonb from updated returning *
       ), wallet as (
         insert into relay_billing_entries(id,transaction_id,tenant_id,account_code,amount_minor,currency)
         select $9,id,tenant_id,'tenant_wallet',$2::bigint,currency from tx
       ), cash as (
         insert into relay_billing_entries(id,transaction_id,tenant_id,account_code,amount_minor,currency)
         select $10,id,tenant_id,'external_settlement',$3::bigint * -1,currency from tx
       ), tax as (
         insert into relay_billing_entries(id,transaction_id,tenant_id,account_code,amount_minor,currency)
         select $11,id,tenant_id,'tax_payable',$4::bigint,currency from tx where $4::bigint>0
       ) select * from tx`,
      [input.tenantId, input.creditMinor, input.grossMinor, input.taxMinor, transactionId, input.orderId, key,
        `Stripe payment ${input.paymentIntent}`, uid(), uid(), uid(),
        JSON.stringify({ provider: "stripe", paymentIntent: input.paymentIntent, grossMinor: input.grossMinor, taxMinor: input.taxMinor })],
    );
    if (!rows[0]) throw new Error("STRIPE_PAYMENT_LEDGER_FAILED");
    return { replay: false, transaction: rows[0] };
  } catch (error) {
    const replay = await sql.query<Record<string, unknown>>(
      "select * from relay_billing_transactions where tenant_id=$1 and idempotency_key=$2",
      [input.tenantId, key],
    );
    if (replay[0]) return { replay: true, transaction: replay[0] };
    throw error;
  }
}

async function postStripeRefundSettlement(
  input: { tenantId: string; orderId: string; providerRefundId: string; creditMinor: number; taxMinor: number; grossMinor: number },
  sql: DbLike,
) {
  if (input.creditMinor <= 0 || input.taxMinor < 0 || input.grossMinor !== input.creditMinor + input.taxMinor) throw new Error("STRIPE_REFUND_LEDGER_MISMATCH");
  const key = `stripe:refund:${input.providerRefundId}`;
  const existing = await sql.query<Record<string, unknown>>(
    "select * from relay_billing_transactions where tenant_id=$1 and idempotency_key=$2",
    [input.tenantId, key],
  );
  if (existing[0]) return { replay: true, transaction: existing[0] };
  const transactionId = uid();
  try {
    const rows = await sql.query<Record<string, unknown>>(
      `with locked as (
         select id,balance_minor,currency from relay_tenants where id=$1 for update
       ), updated as (
         update relay_tenants t set balance_minor=t.balance_minor-$2::bigint,updated_at=now()
          from locked l where t.id=l.id returning t.id,t.balance_minor,t.currency
       ), tx as (
         insert into relay_billing_transactions
          (id,tenant_id,order_id,kind,currency,amount_minor,balance_after_minor,idempotency_key,description,created_at,extra)
         select $5,id,$6,'refund',currency,$2::bigint * -1,balance_minor,$7,$8,now(),$12::jsonb from updated returning *
       ), wallet as (
         insert into relay_billing_entries(id,transaction_id,tenant_id,account_code,amount_minor,currency)
         select $9,id,tenant_id,'tenant_wallet',$2::bigint * -1,currency from tx
       ), cash as (
         insert into relay_billing_entries(id,transaction_id,tenant_id,account_code,amount_minor,currency)
         select $10,id,tenant_id,'external_settlement',$3::bigint,currency from tx
       ), tax as (
         insert into relay_billing_entries(id,transaction_id,tenant_id,account_code,amount_minor,currency)
         select $11,id,tenant_id,'tax_payable',$4::bigint * -1,currency from tx where $4::bigint>0
       ) select * from tx`,
      [input.tenantId, input.creditMinor, input.grossMinor, input.taxMinor, transactionId, input.orderId, key,
        `Stripe refund ${input.providerRefundId}`, uid(), uid(), uid(),
        JSON.stringify({ provider: "stripe", providerRefundId: input.providerRefundId, grossMinor: input.grossMinor, taxMinor: input.taxMinor })],
    );
    if (!rows[0]) throw new Error("STRIPE_REFUND_LEDGER_FAILED");
    return { replay: false, transaction: rows[0] };
  } catch (error) {
    const replay = await sql.query<Record<string, unknown>>(
      "select * from relay_billing_transactions where tenant_id=$1 and idempotency_key=$2",
      [input.tenantId, key],
    );
    if (replay[0]) return { replay: true, transaction: replay[0] };
    throw error;
  }
}

async function settleCheckoutSession(object: Record<string, unknown>, eventRowId: string, sql: DbLike) {
  const metadata = objectValue(object.metadata);
  const orderId = String(metadata.order_id || object.client_reference_id || "");
  const tenantId = String(metadata.tenant_id || "");
  const sessionId = String(object.id || "");
  const paymentIntent = stringId(object.payment_intent);
  const gross = safeInteger(object.amount_total, "STRIPE_PAYMENT_AMOUNT");
  const credit = safeInteger(object.amount_subtotal ?? object.amount_total, "STRIPE_PAYMENT_SUBTOTAL");
  const details = objectValue(object.total_details);
  const tax = safeInteger(details.amount_tax ?? gross - credit, "STRIPE_PAYMENT_TAX");
  const currency = String(object.currency || "").toUpperCase();
  if (!orderId || !sessionId.startsWith("cs_") || !paymentIntent.startsWith("pi_") || credit <= 0 || tax < 0 || gross !== credit + tax || !currency) throw new Error("STRIPE_PAYMENT_IDENTITY_INVALID");
  const rows = await sql.query<Record<string, unknown>>("select * from relay_orders where id=$1", [orderId]);
  const order = rows[0];
  if (!order || order.payment_provider !== "stripe") throw new Error("STRIPE_ORDER_NOT_FOUND");
  if (order.provider_session_id && String(order.provider_session_id) !== sessionId) throw new Error("STRIPE_SESSION_MISMATCH");
  if (tenantId && tenantId !== String(order.tenant_id)) throw new Error("STRIPE_TENANT_MISMATCH");
  if (Number(order.amount_minor) !== credit || String(order.currency) !== currency) throw new Error("STRIPE_PAYMENT_AMOUNT_MISMATCH");
  await postStripePaymentSettlement({ tenantId: String(order.tenant_id), orderId, paymentIntent, creditMinor: credit, taxMinor: tax, grossMinor: gross }, sql);
  await sql.query(
    `update relay_orders set status=case when refunded_minor>=amount_minor then 'refunded' when refunded_minor>0 then 'partially_refunded' else 'paid' end,
       paid_at=coalesce(paid_at,now()),provider_reference=$2,
       provider_session_id=$3,provider_payment_intent=$2,checkout_url=null,tax_minor=$4,gross_minor=$5,updated_at=now()
      where id=$1 and payment_provider='stripe'`,
    [orderId, paymentIntent, sessionId, tax, gross],
  );
  await markEvent(sql, eventRowId, "processed", { orderId, amountMinor: gross, currency });
  return { orderId, creditMinor: credit, taxMinor: tax, grossMinor: gross, currency };
}

async function updateUnpaidSession(object: Record<string, unknown>, status: string, eventRowId: string, sql: DbLike) {
  const metadata = objectValue(object.metadata);
  const orderId = String(metadata.order_id || object.client_reference_id || "");
  const sessionId = String(object.id || "");
  await sql.query(
    `update relay_orders set status=$3,checkout_url=null,updated_at=now()
      where id=$1 and provider_session_id=$2 and status not in ('paid','partially_refunded','refunded')`,
    [orderId, sessionId, status],
  );
  await markEvent(sql, eventRowId, "processed", { orderId: orderId || undefined });
}

async function releaseRefundReservation(refundId: string, status: string, sql: DbLike) {
  await sql.query(
    `with target as (
       select id,tenant_id,reservation_minor from relay_payment_refunds
        where id=$1 and status not in ('succeeded','failed') for update
     ), released as (
       update relay_payment_refunds r set status=$2,updated_at=now(),reservation_minor=0
        from target x where r.id=x.id returning r.id
     ) update relay_tenants t set reserved_minor=greatest(0,t.reserved_minor-x.reservation_minor),updated_at=now()
       from target x,released r where t.id=x.tenant_id`,
    [refundId, status],
  );
}

function allocationForCredit(order: Record<string, unknown>, creditMinor: number) {
  const totalCredit = Number(order.amount_minor);
  const totalTax = Number(order.tax_minor || 0);
  const totalGross = Number(order.gross_minor || totalCredit);
  const remainingCredit = totalCredit - Number(order.refunded_minor || 0);
  const remainingTax = totalTax - Number(order.refunded_tax_minor || 0);
  const remainingGross = totalGross - Number(order.refunded_gross_minor || 0);
  if (creditMinor <= 0 || creditMinor > remainingCredit) throw new Error("REFUND_AMOUNT_INVALID");
  if (remainingTax > 0 && creditMinor !== remainingCredit) throw new Error("PARTIAL_TAX_REFUND_REQUIRES_STRIPE_TAX_REVERSAL");
  const taxMinor = creditMinor === remainingCredit
    ? remainingTax
    : Math.min(remainingTax, Math.max(0, Math.round(totalTax * creditMinor / totalCredit)));
  const grossMinor = creditMinor + taxMinor;
  if (grossMinor > remainingGross) throw new Error("REFUND_ALLOCATION_INVALID");
  return { creditMinor, taxMinor, grossMinor };
}

function allocationForGross(order: Record<string, unknown>, grossMinor: number) {
  const totalCredit = Number(order.amount_minor);
  const totalTax = Number(order.tax_minor || 0);
  const totalGross = Number(order.gross_minor || totalCredit);
  const remainingCredit = totalCredit - Number(order.refunded_minor || 0);
  const remainingTax = totalTax - Number(order.refunded_tax_minor || 0);
  const remainingGross = totalGross - Number(order.refunded_gross_minor || 0);
  if (grossMinor <= 0 || grossMinor > remainingGross) throw new Error("STRIPE_REFUND_AMOUNT_MISMATCH");
  if (grossMinor === remainingGross) return { creditMinor: remainingCredit, taxMinor: remainingTax, grossMinor };
  if (remainingTax > 0) throw new Error("PARTIAL_TAX_REFUND_REQUIRES_STRIPE_TAX_REVERSAL");
  const creditMinor = Math.min(remainingCredit, Math.max(1, Math.round(totalCredit * grossMinor / totalGross)));
  const taxMinor = grossMinor - creditMinor;
  if (taxMinor < 0 || taxMinor > remainingTax) throw new Error("STRIPE_REFUND_TAX_MISMATCH");
  return { creditMinor, taxMinor, grossMinor };
}

async function finalizeRefund(
  input: { refundId: string; providerRefundId: string; orderId: string; amountMinor: number; currency: string },
  sql: DbLike,
) {
  const rows = await sql.query<Record<string, unknown>>(
    `select r.*,o.tenant_id,o.currency as order_currency,o.provider_payment_intent
       from relay_payment_refunds r join relay_orders o on o.id=r.order_id where r.id=$1`,
    [input.refundId],
  );
  const refund = rows[0];
  if (!refund || String(refund.order_id) !== input.orderId || Number(refund.amount_minor) !== input.amountMinor || String(refund.currency) !== input.currency) {
    throw new Error("STRIPE_REFUND_MISMATCH");
  }
  await postStripeRefundSettlement({
    tenantId: String(refund.tenant_id), orderId: input.orderId, providerRefundId: input.providerRefundId,
    creditMinor: Number(refund.credit_minor), taxMinor: Number(refund.tax_minor || 0), grossMinor: input.amountMinor,
  }, sql);
  await releaseRefundReservation(input.refundId, "succeeded", sql);
  await sql.query(
    "update relay_payment_refunds set status='succeeded',provider_refund_id=$2,reservation_minor=0,updated_at=now() where id=$1",
    [input.refundId, input.providerRefundId],
  );
  await sql.query(
    `update relay_orders o set refunded_minor=coalesce((select sum(credit_minor) from relay_payment_refunds r where r.order_id=o.id and r.status='succeeded'),0),
       refunded_tax_minor=coalesce((select sum(tax_minor) from relay_payment_refunds r where r.order_id=o.id and r.status='succeeded'),0),
       refunded_gross_minor=coalesce((select sum(amount_minor) from relay_payment_refunds r where r.order_id=o.id and r.status='succeeded'),0),
       status=case when coalesce((select sum(credit_minor) from relay_payment_refunds r where r.order_id=o.id and r.status='succeeded'),0)>=o.amount_minor then 'refunded' else 'partially_refunded' end,
       updated_at=now() where o.id=$1`,
    [input.orderId],
  );
  await sql.query(
    `update relay_tenants set status=case when balance_minor-reserved_minor < 0 and status in ('trial','active') then 'suspended' else status end,updated_at=now()
       where id=$1`,
    [refund.tenant_id],
  );
}

async function processRefundObject(object: Record<string, unknown>, eventRowId: string, sql: DbLike) {
  const providerRefundId = String(object.id || "");
  const paymentIntent = stringId(object.payment_intent);
  const metadata = objectValue(object.metadata);
  const status = String(object.status || "");
  const amount = safeInteger(object.amount, "STRIPE_REFUND_AMOUNT");
  const currency = String(object.currency || "").toUpperCase();
  if (!providerRefundId.startsWith("re_") || !paymentIntent.startsWith("pi_") || amount <= 0 || !currency) throw new Error("STRIPE_REFUND_IDENTITY_INVALID");
  let orderId = String(metadata.order_id || "");
  const orders = orderId
    ? await sql.query<Record<string, unknown>>("select * from relay_orders where id=$1 and provider_payment_intent=$2", [orderId, paymentIntent])
    : await sql.query<Record<string, unknown>>("select * from relay_orders where provider_payment_intent=$1", [paymentIntent]);
  const order = orders[0];
  if (!order || String(order.currency) !== currency) throw new Error("STRIPE_REFUND_ORDER_NOT_FOUND");
  orderId = String(order.id);
  const prior = await sql.query<{ amount: number }>(
    "select coalesce(sum(amount_minor),0)::bigint as amount from relay_payment_refunds where order_id=$1 and status='succeeded' and provider_refund_id<>$2",
    [orderId, providerRefundId],
  );
  if (Number(prior[0]?.amount || 0) + amount > Number(order.gross_minor || order.amount_minor)) throw new Error("STRIPE_REFUND_AMOUNT_MISMATCH");
  let refunds = await sql.query<Record<string, unknown>>(
    "select * from relay_payment_refunds where provider='stripe' and provider_refund_id=$1",
    [providerRefundId],
  );
  if (!refunds[0]) {
    const allocation = allocationForGross(order, amount);
    refunds = await sql.query<Record<string, unknown>>(
      `insert into relay_payment_refunds
        (id,tenant_id,order_id,provider,provider_refund_id,provider_payment_intent,status,amount_minor,credit_minor,tax_minor,reservation_minor,currency,reason,idempotency_key,created_by)
       values ($1,$2,$3,'stripe',$4,$5,'received',$6,$7,$8,0,$9,'External Stripe refund',$10,'stripe-webhook') returning *`,
      [uid(), order.tenant_id, orderId, providerRefundId, paymentIntent, amount, allocation.creditMinor, allocation.taxMinor, currency, `stripe-external:${providerRefundId}`],
    );
  }
  const refund = refunds[0]!;
  if (Number(refund.amount_minor) !== amount || String(refund.order_id) !== orderId) throw new Error("STRIPE_REFUND_MISMATCH");
  if (status === "failed" || status === "canceled") {
    await releaseRefundReservation(String(refund.id), "failed", sql);
  } else if (status === "succeeded") {
    await finalizeRefund({ refundId: String(refund.id), providerRefundId, orderId, amountMinor: amount, currency }, sql);
  } else {
    await sql.query("update relay_payment_refunds set status='pending',provider_refund_id=$2,updated_at=now() where id=$1", [refund.id, providerRefundId]);
  }
  await markEvent(sql, eventRowId, "processed", { orderId, amountMinor: amount, currency });
}

async function processDisputeObject(object: Record<string, unknown>, eventType: string, eventRowId: string, sql: DbLike) {
  const providerDisputeId = String(object.id || "");
  const paymentIntent = stringId(object.payment_intent);
  const chargeId = stringId(object.charge);
  const amount = safeInteger(object.amount, "STRIPE_DISPUTE_AMOUNT");
  const currency = String(object.currency || "").toUpperCase();
  const status = String(object.status || "needs_response");
  const reason = String(object.reason || "unknown").slice(0, 120);
  const evidence = objectValue(object.evidence_details);
  const dueBy = Number(evidence.due_by || 0);
  if (!/^(du|dp)_/.test(providerDisputeId) || !paymentIntent.startsWith("pi_") || amount <= 0 || !currency) {
    throw new Error("STRIPE_DISPUTE_IDENTITY_INVALID");
  }
  const orders = await sql.query<Record<string, unknown>>(
    "select * from relay_orders where payment_provider='stripe' and provider_payment_intent=$1",
    [paymentIntent],
  );
  const order = orders[0];
  if (!order || String(order.currency) !== currency || amount > Number(order.gross_minor || order.amount_minor)) throw new Error("STRIPE_DISPUTE_ORDER_MISMATCH");
  const disputes = await sql.query<Record<string, unknown>>(
    `insert into relay_payment_disputes
      (id,tenant_id,order_id,provider,provider_dispute_id,provider_payment_intent,provider_charge_id,status,amount_minor,currency,reason,evidence_due_at)
     values ($1,$2,$3,'stripe',$4,$5,$6,$7,$8,$9,$10,case when $11>0 then to_timestamp($11) else null end)
     on conflict (provider,provider_dispute_id) do update set
       status=excluded.status,provider_payment_intent=coalesce(excluded.provider_payment_intent,relay_payment_disputes.provider_payment_intent),
       provider_charge_id=coalesce(excluded.provider_charge_id,relay_payment_disputes.provider_charge_id),reason=excluded.reason,
       evidence_due_at=coalesce(excluded.evidence_due_at,relay_payment_disputes.evidence_due_at),updated_at=now()
     returning *`,
    [uid(), order.tenant_id, order.id, providerDisputeId, paymentIntent, chargeId || null, status, amount, currency, reason, dueBy],
  );
  const dispute = disputes[0]!;
  await sql.query(
    "update relay_tenants set status=case when status in ('trial','active') then 'suspended' else status end,updated_at=now() where id=$1",
    [order.tenant_id],
  );
  if (eventType === "charge.dispute.funds_withdrawn") {
    await postBalanceAdjustment({
      tenantId: String(order.tenant_id), deltaMinor: -amount, kind: "chargeback",
      idempotencyKey: `stripe:dispute-withdrawn:${providerDisputeId}`, orderId: String(order.id),
      description: `Stripe dispute funds withdrawn ${providerDisputeId}`,
      counterAccountCode: "payment_dispute", allowNegative: true, allowInactive: true,
    }, sql);
    await sql.query("update relay_payment_disputes set funds_withdrawn=true,updated_at=now() where id=$1", [dispute.id]);
  } else if (eventType === "charge.dispute.funds_reinstated") {
    const withdrawn = await sql.query<{ id: string }>(
      "select id from relay_billing_transactions where tenant_id=$1 and idempotency_key=$2",
      [order.tenant_id, `stripe:dispute-withdrawn:${providerDisputeId}`],
    );
    if (!withdrawn[0]) throw new Error("STRIPE_DISPUTE_WITHDRAWAL_NOT_RECORDED");
    await postBalanceAdjustment({
      tenantId: String(order.tenant_id), deltaMinor: amount, kind: "adjustment",
      idempotencyKey: `stripe:dispute-reinstated:${providerDisputeId}`, orderId: String(order.id),
      description: `Stripe dispute funds reinstated ${providerDisputeId}`,
      counterAccountCode: "payment_dispute", allowInactive: true,
    }, sql);
    await sql.query("update relay_payment_disputes set funds_reinstated=true,updated_at=now() where id=$1", [dispute.id]);
  }
  await markEvent(sql, eventRowId, "processed", { orderId: String(order.id), amountMinor: amount, currency });
}

export async function processStripeWebhook(
  parsed: { event: StripeEvent; signatureTimestamp: number; payloadSha256: string },
  options: { env?: NodeJS.ProcessEnv; db?: DbLike } = {},
) {
  const env = options.env || process.env;
  const sql = await dbOrDefault(options.db);
  const { event } = parsed;
  if (env.NODE_ENV === "production" && event.livemode !== true) throw new Error("STRIPE_LIVEMODE_EVENT_REQUIRED");
  const recorded = await recordEvent(parsed, sql);
  const eventRowId = String(recorded.row.id);
  if (recorded.replay) return { replay: true, status: recorded.row.status };
  try {
    const object = event.data.object;
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      if (String(object.payment_status) === "paid") await settleCheckoutSession(object, eventRowId, sql);
      else {
        await sql.query("update relay_orders set status='awaiting_payment',updated_at=now() where id=$1 and status='checkout_open'", [objectValue(object.metadata).order_id || object.client_reference_id]);
        await markEvent(sql, eventRowId, "processed");
      }
    } else if (event.type === "checkout.session.expired") {
      await updateUnpaidSession(object, "expired", eventRowId, sql);
    } else if (event.type === "checkout.session.async_payment_failed") {
      await updateUnpaidSession(object, "payment_failed", eventRowId, sql);
    } else if (["refund.created", "refund.updated"].includes(event.type)) {
      await processRefundObject(object, eventRowId, sql);
    } else if (["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated"].includes(event.type)) {
      await processDisputeObject(object, event.type, eventRowId, sql);
    } else {
      await markEvent(sql, eventRowId, "ignored");
    }
    return { replay: false, status: "processed" };
  } catch (error) {
    await markEvent(sql, eventRowId, "failed", { error: error instanceof Error ? error.message : "PAYMENT_EVENT_FAILED" });
    throw error;
  }
}

export async function createStripeRefund(
  input: { orderId: string; amountMinor: number; reason: string; idempotencyKey: string; actor: string },
  options: { env?: NodeJS.ProcessEnv; db?: DbLike; fetcher?: FetchLike } = {},
) {
  const env = options.env || process.env;
  const sql = await dbOrDefault(options.db);
  const fetcher = options.fetcher || fetch;
  stripeConfig(env);
  const amount = safeInteger(input.amountMinor, "REFUND_AMOUNT");
  if (amount <= 0) throw new Error("REFUND_AMOUNT_INVALID");
  const orderRows = await sql.query<Record<string, unknown>>("select * from relay_orders where id=$1 and payment_provider='stripe'", [input.orderId]);
  const orderForAllocation = orderRows[0];
  if (!orderForAllocation) throw new Error("REFUND_ORDER_NOT_FOUND");
  const normalizedIdempotency = input.idempotencyKey.slice(0, 200);
  const preexisting = await sql.query<Record<string, unknown>>(
    "select * from relay_payment_refunds where order_id=$1 and idempotency_key=$2",
    [input.orderId, normalizedIdempotency],
  );
  const replayRefund = preexisting[0];
  if (replayRefund) {
    if (Number(replayRefund.credit_minor) !== amount) throw new Error("REFUND_IDEMPOTENCY_CONFLICT");
    if (["succeeded", "pending"].includes(String(replayRefund.status))) return { replay: true, refund: replayRefund };
    if (["failed", "canceled"].includes(String(replayRefund.status))) throw new Error("REFUND_IDEMPOTENCY_TERMINAL");
  }
  const allocation = replayRefund
    ? { creditMinor: Number(replayRefund.credit_minor), taxMinor: Number(replayRefund.tax_minor || 0), grossMinor: Number(replayRefund.amount_minor) }
    : allocationForCredit(orderForAllocation, amount);
  const refundId = uid();
  const held = replayRefund ? [] : await sql.query<Record<string, unknown>>(
    `with locked as (
       select o.*,t.balance_minor,t.reserved_minor from relay_orders o join relay_tenants t on t.id=o.tenant_id
        where o.id=$1 and o.payment_provider='stripe' and o.status in ('paid','partially_refunded') for update of o,t
     ), inserted as (
       insert into relay_payment_refunds
        (id,tenant_id,order_id,provider,provider_payment_intent,status,amount_minor,credit_minor,tax_minor,reservation_minor,currency,reason,idempotency_key,created_by)
       select $2,tenant_id,id,'stripe',provider_payment_intent,'creating',$5,$3,$4,$3,currency,$6,$7,$8 from locked
        where provider_payment_intent is not null and $3 <= amount_minor-refunded_minor
          and $4 <= tax_minor-refunded_tax_minor and $5 <= gross_minor-refunded_gross_minor
          and balance_minor-reserved_minor >= $3
       on conflict (tenant_id,idempotency_key) do nothing returning *
     ), reserved as (
       update relay_tenants t set reserved_minor=t.reserved_minor+i.reservation_minor,updated_at=now() from inserted i where t.id=i.tenant_id returning t.id
     ) select i.* from inserted i join reserved r on r.id=i.tenant_id`,
    [input.orderId, refundId, allocation.creditMinor, allocation.taxMinor, allocation.grossMinor,
      input.reason.slice(0, 300), normalizedIdempotency, input.actor.slice(0, 120)],
  );
  let refund = replayRefund || held[0];
  if (!refund) {
    const rows = await sql.query<Record<string, unknown>>(
      `select r.* from relay_payment_refunds r join relay_orders o on o.id=r.order_id
        where r.order_id=$1 and r.idempotency_key=$2`,
      [input.orderId, normalizedIdempotency],
    );
    refund = rows[0];
    if (!refund || Number(refund.credit_minor) !== amount) throw new Error("REFUND_NOT_ALLOWED_OR_BALANCE_INSUFFICIENT");
    if (["succeeded", "pending"].includes(String(refund.status))) return { replay: true, refund };
    if (["failed", "canceled"].includes(String(refund.status))) throw new Error("REFUND_IDEMPOTENCY_TERMINAL");
  }
  if (!refund) throw new Error("REFUND_CREATE_FAILED");
  let remoteSucceeded = false;
  try {
    const form = new URLSearchParams();
    form.set("payment_intent", String(refund.provider_payment_intent));
    form.set("amount", String(refund.amount_minor));
    form.set("metadata[order_id]", input.orderId);
    form.set("metadata[relay_refund_id]", String(refund.id));
    form.set("reason", "requested_by_customer");
    const remote = await stripeRequest("/refunds", { form, idempotencyKey: `relay-refund:${String(refund.id)}` }, env, fetcher);
    const providerRefundId = String(remote.id || "");
    const status = String(remote.status || "pending");
    if (!providerRefundId.startsWith("re_") || safeInteger(remote.amount, "STRIPE_REFUND_AMOUNT") !== Number(refund.amount_minor)) throw new Error("STRIPE_REFUND_MISMATCH");
    const storedStatus = status === "succeeded" ? "settlement_pending" : status;
    await sql.query("update relay_payment_refunds set provider_refund_id=$2,status=$3,updated_at=now() where id=$1", [refund.id, providerRefundId, storedStatus]);
    if (status === "succeeded") {
      remoteSucceeded = true;
      const orders = await sql.query<Record<string, unknown>>("select currency from relay_orders where id=$1", [input.orderId]);
      await finalizeRefund({ refundId: String(refund.id), providerRefundId, orderId: input.orderId, amountMinor: Number(refund.amount_minor), currency: String(orders[0]?.currency || "") }, sql);
    } else if (status === "failed" || status === "canceled") {
      await releaseRefundReservation(String(refund.id), "failed", sql);
    }
    const rows = await sql.query<Record<string, unknown>>("select * from relay_payment_refunds where id=$1", [refund.id]);
    return { replay: false, refund: rows[0] };
  } catch (error) {
    if (remoteSucceeded) {
      await sql.query("update relay_payment_refunds set status='settlement_pending',updated_at=now() where id=$1 and status<>'succeeded'", [refund.id]);
    } else {
      await releaseRefundReservation(String(refund.id), "failed", sql);
    }
    throw error;
  }
}

export async function reconcileStripeOrder(
  orderId: string,
  options: { env?: NodeJS.ProcessEnv; db?: DbLike; fetcher?: FetchLike } = {},
) {
  const env = options.env || process.env;
  const sql = await dbOrDefault(options.db);
  const rows = await sql.query<Record<string, unknown>>("select * from relay_orders where id=$1 and payment_provider='stripe'", [orderId]);
  const order = rows[0];
  if (!order?.provider_session_id) throw new Error("STRIPE_ORDER_SESSION_NOT_FOUND");
  const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(String(order.provider_session_id))}`, { method: "GET" }, env, options.fetcher || fetch);
  const synthetic: StripeEvent = { id: `evt_reconcile_${createHash("sha256").update(`${orderId}:${String(session.id)}:${String(session.payment_status)}`).digest("hex").slice(0, 24)}`, type: "checkout.session.completed", livemode: Boolean(session.livemode), data: { object: session } };
  return processStripeWebhook({ event: synthetic, signatureTimestamp: Math.floor(Date.now() / 1000), payloadSha256: createHash("sha256").update(JSON.stringify(session)).digest("hex") }, { env, db: sql });
}
