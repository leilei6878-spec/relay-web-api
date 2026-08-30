import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { allocationForCredit, allocationForGross, createStripeCheckout, createStripeRefund, parseStripeWebhook, processStripeWebhook, verifyStripeSignature } from "./payments.ts";
import { createTenantOwner } from "./saas-billing.ts";
import { expectedCommercialEvidence, recordCommercialEvidence } from "./commercial-evidence.ts";

async function database() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of [
    "0001_relay.sql", "0002_relay_ops.sql", "0003_relay_production.sql", "0004_schema_meta.sql",
    "0005_account_operations.sql", "0006_account_availability_samples.sql", "0007_commercial_saas.sql",
    "0008_commercial_payments.sql", "0009_commercial_config.sql", "0010_provider_sandbox.sql", "0011_commercial_launch_evidence.sql", "0012_admin_sessions.sql", "0013_plan_periods.sql", "0014_saas_session_mfa.sql", "0015_tenant_audit.sql", "0016_alert_delivery_outbox.sql",
  ]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  const db = { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows };
  const owner = await createTenantOwner({
    tenantName: "Payment QA", ownerName: "Owner", email: "payments@example.test", password: "Test-Password-123!",
  }, db);
  await pg.query("insert into relay_workers(id,name,last_beat,draining) values ('pay-w1','pay-w1',now(),false),('pay-w2','pay-w2',now(),false)");
  await pg.query("insert into relay_meta(key,value,updated_at) values ('scheduler_last_beat','test',now()) on conflict(key) do update set value='test',updated_at=now()");
  await pg.query(`insert into relay_price_book(id,version,provider,model,capability,currency,input_micros_per_million,output_micros_per_million,image_price_minor,markup_basis_points,effective_from,status)
    values ('pay-price',1,'openai','gpt-test','chat','USD',1,1,0,0,now(),'active')`);
  await pg.query(`insert into relay_provider_sandbox_runs(id,provider,model,capability,mode,status,currency,estimated_charge_minor,initiated_by,started_at,finished_at)
    values ('pay-canary','openai','gpt-test','chat','live','passed','USD',1,'test',now(),now())`);
  for (const item of await expectedCommercialEvidence(env, db)) {
    const identity = `${item.requirement}:${item.subject}`;
    await recordCommercialEvidence({
      requirement: item.requirement, subject: item.subject, status: "passed",
      artifactRef: `PAYMENT-QA-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`,
      artifactSha256: createHash("sha256").update(`artifact:${identity}`).digest("hex"),
      note: "Independent payment test review", reviewer: "reviewer@example.test",
      observedAt: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      confirmation: "EVIDENCE_REVIEWED", actor: "admin",
    }, db);
  }
  return { pg, db, owner };
}

const env = {
  NODE_ENV: "test",
  RELAY_COMMERCIAL_ENABLED: "1",
  RELAY_PAYMENT_PROVIDER: "stripe",
  RELAY_PUBLIC_URL: "https://relay.example.test",
  STRIPE_SECRET_KEY: "unit-payment-key",
  STRIPE_WEBHOOK_SECRET: "unit-signing-secret",
  OPENAI_API_KEY: "official-test-key",
  REDIS_URL: "redis://unused",
  RELAY_GATEWAY_REPLICA_COUNT: "2",
  RELAY_COMMERCIAL_MIN_WORKERS: "2",
  RELAY_BACKUP_S3_ENDPOINT: "https://backup.example.test",
  RELAY_BACKUP_S3_BUCKET: "relay-offsite",
  RELAY_LEGAL_APPROVED: "1",
  RELAY_TAX_MODE: "approved_exempt",
  RELAY_REQUIRE_ADMIN_MFA: "1",
  RELAY_ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
  RELAY_REQUIRE_PRIVILEGED_SAAS_MFA: "1",
  RELAY_SECRETS_KEY: "payment-test-secret-key-0123456789abcdef",
  RELAY_ALERT_WEBHOOK_URL: "https://alerts.example.test/relay",
  RELAY_ALERT_WEBHOOK_SECRET: "payment-alert-secret-0123456789abcdef",
} as NodeJS.ProcessEnv;

function checkoutResponse(orderId: string, amount = 2500) {
  return {
    id: "cs_test_checkout_1",
    object: "checkout.session",
    url: "https://checkout.stripe.com/c/pay/cs_test_checkout_1",
    amount_total: amount,
    currency: "usd",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    livemode: false,
    payment_status: "unpaid",
    payment_intent: null,
    client_reference_id: orderId,
    metadata: { order_id: orderId },
  };
}

test("Stripe signature verification uses raw body, constant-time HMAC input and a replay window", () => {
  const raw = JSON.stringify({ id: "evt_test", type: "ping", data: { object: {} } });
  const timestamp = 2_000_000_000;
  const digest = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET!).update(`${timestamp}.${raw}`).digest("hex");
  assert.equal(verifyStripeSignature(raw, `t=${timestamp},v1=${digest}`, env.STRIPE_WEBHOOK_SECRET!, timestamp * 1000), timestamp);
  assert.throws(() => verifyStripeSignature(`${raw} `, `t=${timestamp},v1=${digest}`, env.STRIPE_WEBHOOK_SECRET!, timestamp * 1000), /INVALID/);
  assert.throws(() => verifyStripeSignature(raw, `t=${timestamp},v1=${digest}`, env.STRIPE_WEBHOOK_SECRET!, (timestamp + 301) * 1000), /STALE/);
});

test("cumulative tax allocation is partition-invariant and ambiguous external gross refunds fail closed", () => {
  const original = { amount_minor: 3, tax_minor: 1, gross_minor: 4, refunded_minor: 0, refunded_tax_minor: 0, refunded_gross_minor: 0 };
  const first = allocationForCredit(original, 1);
  assert.deepEqual(first, { creditMinor: 1, taxMinor: 0, grossMinor: 1 });
  const second = allocationForCredit({ ...original, refunded_minor: 1, refunded_tax_minor: 0, refunded_gross_minor: 1 }, 1);
  assert.deepEqual(second, { creditMinor: 1, taxMinor: 0, grossMinor: 1 });
  const final = allocationForCredit({ ...original, refunded_minor: 2, refunded_tax_minor: 0, refunded_gross_minor: 2 }, 1);
  assert.deepEqual(final, { creditMinor: 1, taxMinor: 1, grossMinor: 2 });
  const oneThenFinal = allocationForCredit({ ...original, refunded_minor: 1, refunded_tax_minor: 0, refunded_gross_minor: 1 }, 2);
  assert.deepEqual(oneThenFinal, { creditMinor: 2, taxMinor: 1, grossMinor: 3 });
  const taxed = { amount_minor: 2500, tax_minor: 250, gross_minor: 2750, refunded_minor: 0, refunded_tax_minor: 0, refunded_gross_minor: 0 };
  assert.deepEqual(allocationForGross(taxed, 1100), { creditMinor: 1000, taxMinor: 100, grossMinor: 1100 });
  assert.throws(() => allocationForGross(taxed, 10), /ALLOCATION_AMBIGUOUS/);
});

test("Checkout creation is tenant-bound, server-priced and idempotent", async () => {
  const { pg, db, owner } = await database();
  let calls = 0;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${env.STRIPE_SECRET_KEY}`);
    assert.match(String((init?.headers as Record<string, string>)["Idempotency-Key"]), /^relay-order:/);
    const form = new URLSearchParams(String(init?.body));
    const orderId = form.get("metadata[order_id]")!;
    assert.equal(form.get("metadata[tenant_id]"), owner.tenantId);
    assert.equal(form.get("line_items[0][price_data][unit_amount]"), "2500");
    assert.equal(form.get("success_url"), "https://relay.example.test/portal?checkout=success");
    return Response.json(checkoutResponse(orderId));
  }) as typeof fetch;
  const first = await createStripeCheckout({ tenantId: owner.tenantId, amountMinor: 2500, idempotencyKey: "checkout-1" }, { env, db, fetcher });
  assert.equal(first.replay, false);
  assert.match(first.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  const second = await createStripeCheckout({ tenantId: owner.tenantId, amountMinor: 2500, idempotencyKey: "checkout-1" }, { env, db, fetcher });
  assert.equal(second.replay, true);
  assert.equal(calls, 1);
  const rows = await pg.query<{ status: string; payment_provider: string }>("select status,payment_provider from relay_orders");
  assert.deepEqual(rows.rows, [{ status: "checkout_open", payment_provider: "stripe" }]);
  await pg.close();
});

test("signed Checkout webhook credits once, stores no raw payload and rejects amount substitution", async () => {
  const { pg, db, owner } = await database();
  let orderId = "";
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    orderId = new URLSearchParams(String(init?.body)).get("metadata[order_id]")!;
    return Response.json(checkoutResponse(orderId));
  }) as typeof fetch;
  await createStripeCheckout({ tenantId: owner.tenantId, amountMinor: 2500, idempotencyKey: "checkout-2" }, { env, db, fetcher });
  const event = {
    id: "evt_checkout_paid_1", type: "checkout.session.completed", livemode: false,
    data: { object: { ...checkoutResponse(orderId), payment_status: "paid", payment_intent: "pi_test_paid_1", metadata: { order_id: orderId, tenant_id: owner.tenantId } } },
  };
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET!).update(`${timestamp}.${raw}`).digest("hex");
  const parsed = parseStripeWebhook(raw, `t=${timestamp},v1=${signature}`, env);
  await processStripeWebhook(parsed, { env, db });
  const replay = await processStripeWebhook(parsed, { env, db });
  assert.equal(replay.replay, true);
  const secondDelivery = structuredClone(event);
  secondDelivery.id = "evt_checkout_paid_2";
  secondDelivery.type = "checkout.session.async_payment_succeeded";
  await processStripeWebhook({ event: secondDelivery, signatureTimestamp: timestamp, payloadSha256: "second-delivery" }, { env, db });
  const tenant = await pg.query<{ balance_minor: bigint }>("select balance_minor from relay_tenants where id=$1", [owner.tenantId]);
  assert.equal(Number(tenant.rows[0]?.balance_minor), 2500);
  const transactions = await pg.query<{ count: number }>("select count(*)::int as count from relay_billing_transactions where tenant_id=$1", [owner.tenantId]);
  assert.equal(transactions.rows[0]?.count, 1);
  const balanced = await pg.query<{ total: bigint }>("select coalesce(sum(amount_minor),0)::bigint as total from relay_billing_entries where tenant_id=$1", [owner.tenantId]);
  assert.equal(Number(balanced.rows[0]?.total), 0);
  const stored = await pg.query<{ payload_sha256: string; extra: Record<string, unknown>; attempt_count: number }>("select payload_sha256,extra,attempt_count from relay_payment_events");
  assert.equal(stored.rows[0]?.payload_sha256, createHash("sha256").update(raw).digest("hex"));
  assert.deepEqual(stored.rows[0]?.extra, {});
  assert.equal(stored.rows[0]?.attempt_count, 2);

  const bad = structuredClone(event);
  bad.id = "evt_checkout_bad_amount";
  bad.data.object.amount_total = 2600;
  await assert.rejects(() => processStripeWebhook({ event: bad, signatureTimestamp: timestamp, payloadSha256: "bad" }, { env, db }), /AMOUNT_MISMATCH/);
  const after = await pg.query<{ balance_minor: bigint }>("select balance_minor from relay_tenants where id=$1", [owner.tenantId]);
  assert.equal(Number(after.rows[0]?.balance_minor), 2500);
  await pg.close();
});

test("external partial taxed refund reconciles exact gross allocation and rejects ambiguous amounts", async () => {
  const { pg, db, owner } = await database();
  let orderId = "";
  const checkoutFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    orderId = new URLSearchParams(String(init?.body)).get("metadata[order_id]")!;
    return Response.json(checkoutResponse(orderId));
  }) as typeof fetch;
  await createStripeCheckout({ tenantId: owner.tenantId, amountMinor: 2500, idempotencyKey: "checkout-external-refund" }, { env, db, fetcher: checkoutFetch });
  const paid = { id: "evt_paid_external_refund", type: "checkout.session.completed", livemode: false, data: { object: { ...checkoutResponse(orderId), amount_subtotal: 2500, amount_total: 2750, total_details: { amount_tax: 250 }, payment_status: "paid", payment_intent: "pi_external_refund", metadata: { order_id: orderId, tenant_id: owner.tenantId } } } };
  await processStripeWebhook({ event: paid, signatureTimestamp: 1, payloadSha256: "paid-external-refund" }, { env, db });
  const partial = { id: "evt_external_refund_partial", type: "refund.updated", livemode: false, data: { object: { id: "re_external_partial", payment_intent: "pi_external_refund", amount: 1100, currency: "usd", status: "succeeded", metadata: { order_id: orderId } } } };
  await processStripeWebhook({ event: partial, signatureTimestamp: 1, payloadSha256: "external-refund-partial" }, { env, db });
  const refund = await pg.query<{ credit_minor: bigint; tax_minor: bigint; amount_minor: bigint; extra: Record<string, unknown> }>("select credit_minor,tax_minor,amount_minor,extra from relay_payment_refunds where provider_refund_id='re_external_partial'");
  assert.equal(Number(refund.rows[0]?.credit_minor), 1000);
  assert.equal(Number(refund.rows[0]?.tax_minor), 100);
  assert.equal(Number(refund.rows[0]?.amount_minor), 1100);
  assert.deepEqual(refund.rows[0]?.extra, { allocationSource: "gross", taxAllocation: "checkout_cumulative_proportional_v1" });
  const tenant = await pg.query<{ balance_minor: bigint }>("select balance_minor from relay_tenants where id=$1", [owner.tenantId]);
  assert.equal(Number(tenant.rows[0]?.balance_minor), 1500);
  const ambiguous = { id: "evt_external_refund_ambiguous", type: "refund.updated", livemode: false, data: { object: { id: "re_external_ambiguous", payment_intent: "pi_external_refund", amount: 10, currency: "usd", status: "succeeded", metadata: { order_id: orderId } } } };
  await assert.rejects(
    () => processStripeWebhook({ event: ambiguous, signatureTimestamp: 1, payloadSha256: "external-refund-ambiguous" }, { env, db }),
    /ALLOCATION_AMBIGUOUS/,
  );
  const unchanged = await pg.query<{ balance_minor: bigint }>("select balance_minor from relay_tenants where id=$1", [owner.tenantId]);
  assert.equal(Number(unchanged.rows[0]?.balance_minor), 1500);
  await pg.close();
});

test("failed refund submission releases the wallet hold without changing balance", async () => {
  const { pg, db, owner } = await database();
  let orderId = "";
  const checkoutFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    orderId = new URLSearchParams(String(init?.body)).get("metadata[order_id]")!;
    return Response.json(checkoutResponse(orderId));
  }) as typeof fetch;
  await createStripeCheckout({ tenantId: owner.tenantId, amountMinor: 2500, idempotencyKey: "checkout-failed-refund" }, { env, db, fetcher: checkoutFetch });
  const paid = { id: "evt_paid_failed_refund", type: "checkout.session.completed", livemode: false, data: { object: { ...checkoutResponse(orderId), payment_status: "paid", payment_intent: "pi_failed_refund", metadata: { order_id: orderId, tenant_id: owner.tenantId } } } };
  await processStripeWebhook({ event: paid, signatureTimestamp: 1, payloadSha256: "paid-failed-refund" }, { env, db });
  const failingFetch = (async () => { throw new Error("network unavailable"); }) as typeof fetch;
  await assert.rejects(
    () => createStripeRefund({ orderId, amountMinor: 500, reason: "failure test", idempotencyKey: "refund-fails", actor: "admin" }, { env, db, fetcher: failingFetch }),
    /network unavailable/,
  );
  const tenant = await pg.query<{ balance_minor: bigint; reserved_minor: bigint }>("select balance_minor,reserved_minor from relay_tenants where id=$1", [owner.tenantId]);
  assert.equal(Number(tenant.rows[0]?.balance_minor), 2500);
  assert.equal(Number(tenant.rows[0]?.reserved_minor), 0);
  const refund = await pg.query<{ status: string; reservation_minor: bigint }>("select status,reservation_minor from relay_payment_refunds");
  assert.equal(refund.rows[0]?.status, "failed");
  assert.equal(Number(refund.rows[0]?.reservation_minor), 0);
  await pg.close();
});

test("dispute events suspend the tenant and idempotently mirror withdrawn and reinstated funds", async () => {
  const { pg, db, owner } = await database();
  let orderId = "";
  const checkoutFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    orderId = new URLSearchParams(String(init?.body)).get("metadata[order_id]")!;
    return Response.json(checkoutResponse(orderId));
  }) as typeof fetch;
  await createStripeCheckout({ tenantId: owner.tenantId, amountMinor: 2500, idempotencyKey: "checkout-dispute" }, { env, db, fetcher: checkoutFetch });
  const paid = { id: "evt_paid_dispute", type: "checkout.session.completed", livemode: false, data: { object: { ...checkoutResponse(orderId), payment_status: "paid", payment_intent: "pi_disputed", metadata: { order_id: orderId, tenant_id: owner.tenantId } } } };
  await processStripeWebhook({ event: paid, signatureTimestamp: 1, payloadSha256: "paid-dispute" }, { env, db });
  const disputeObject = { id: "du_test_dispute", payment_intent: "pi_disputed", charge: "ch_test_dispute", amount: 2500, currency: "usd", status: "needs_response", reason: "fraudulent", evidence_details: { due_by: Math.floor(Date.now() / 1000) + 86400 } };
  await processStripeWebhook({ event: { id: "evt_dispute_created", type: "charge.dispute.created", livemode: false, data: { object: disputeObject } }, signatureTimestamp: 1, payloadSha256: "dispute-created" }, { env, db });
  let tenant = await pg.query<{ balance_minor: bigint; status: string }>("select balance_minor,status from relay_tenants where id=$1", [owner.tenantId]);
  assert.equal(tenant.rows[0]?.status, "suspended");
  assert.equal(Number(tenant.rows[0]?.balance_minor), 2500);
  await processStripeWebhook({ event: { id: "evt_dispute_withdrawn", type: "charge.dispute.funds_withdrawn", livemode: false, data: { object: disputeObject } }, signatureTimestamp: 1, payloadSha256: "dispute-withdrawn" }, { env, db });
  await processStripeWebhook({ event: { id: "evt_dispute_withdrawn_again", type: "charge.dispute.funds_withdrawn", livemode: false, data: { object: disputeObject } }, signatureTimestamp: 1, payloadSha256: "dispute-withdrawn-again" }, { env, db });
  tenant = await pg.query<{ balance_minor: bigint; status: string }>("select balance_minor,status from relay_tenants where id=$1", [owner.tenantId]);
  assert.equal(Number(tenant.rows[0]?.balance_minor), 0);
  const wonObject = { ...disputeObject, status: "won" };
  await processStripeWebhook({ event: { id: "evt_dispute_reinstated", type: "charge.dispute.funds_reinstated", livemode: false, data: { object: wonObject } }, signatureTimestamp: 1, payloadSha256: "dispute-reinstated" }, { env, db });
  tenant = await pg.query<{ balance_minor: bigint; status: string }>("select balance_minor,status from relay_tenants where id=$1", [owner.tenantId]);
  assert.equal(Number(tenant.rows[0]?.balance_minor), 2500);
  assert.equal(tenant.rows[0]?.status, "suspended");
  const dispute = await pg.query<{ funds_withdrawn: boolean; funds_reinstated: boolean; status: string }>("select funds_withdrawn,funds_reinstated,status from relay_payment_disputes");
  assert.equal(dispute.rows[0]?.funds_withdrawn, true);
  assert.equal(dispute.rows[0]?.funds_reinstated, true);
  assert.equal(dispute.rows[0]?.status, "won");
  const balanced = await pg.query<{ total: bigint }>("select coalesce(sum(amount_minor),0)::bigint as total from relay_billing_entries where tenant_id=$1", [owner.tenantId]);
  assert.equal(Number(balanced.rows[0]?.total), 0);
  await pg.close();
});

test("partial taxed refunds use cumulative allocation, reserve cash and finish with balanced exact totals", async () => {
  const { pg, db, owner } = await database();
  let orderId = "";
  const checkoutFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    orderId = new URLSearchParams(String(init?.body)).get("metadata[order_id]")!;
    return Response.json(checkoutResponse(orderId));
  }) as typeof fetch;
  await createStripeCheckout({ tenantId: owner.tenantId, amountMinor: 2500, idempotencyKey: "checkout-refund" }, { env, db, fetcher: checkoutFetch });
  const paid = { id: "evt_paid_refund", type: "checkout.session.completed", livemode: false, data: { object: { ...checkoutResponse(orderId), amount_subtotal: 2500, amount_total: 2750, total_details: { amount_tax: 250 }, payment_status: "paid", payment_intent: "pi_refundable", metadata: { order_id: orderId, tenant_id: owner.tenantId } } } };
  await processStripeWebhook({ event: paid, signatureTimestamp: 1, payloadSha256: "paid-refund" }, { env, db });
  const partialFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const held = await pg.query<{ reserved_minor: bigint }>("select reserved_minor from relay_tenants where id=$1", [owner.tenantId]);
    assert.equal(Number(held.rows[0]?.reserved_minor), 1000);
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("payment_intent"), "pi_refundable");
    assert.equal(form.get("amount"), "1100");
    return Response.json({ id: "re_test_refund_partial", amount: 1100, status: "succeeded" });
  }) as typeof fetch;
  const partial = await createStripeRefund({ orderId, amountMinor: 1000, reason: "QA partial refund", idempotencyKey: "refund-partial", actor: "admin" }, { env, db, fetcher: partialFetch });
  assert.equal(partial.replay, false);
  let tenant = await pg.query<{ balance_minor: bigint; reserved_minor: bigint }>("select balance_minor,reserved_minor from relay_tenants where id=$1", [owner.tenantId]);
  assert.equal(Number(tenant.rows[0]?.balance_minor), 1500);
  assert.equal(Number(tenant.rows[0]?.reserved_minor), 0);
  let order = await pg.query<{ status: string; refunded_minor: bigint; refunded_tax_minor: bigint; refunded_gross_minor: bigint }>("select status,refunded_minor,refunded_tax_minor,refunded_gross_minor from relay_orders where id=$1", [orderId]);
  assert.equal(order.rows[0]?.status, "partially_refunded");
  assert.equal(Number(order.rows[0]?.refunded_minor), 1000);
  assert.equal(Number(order.rows[0]?.refunded_tax_minor), 100);
  assert.equal(Number(order.rows[0]?.refunded_gross_minor), 1100);
  const storedPartial = await pg.query<{ extra: Record<string, unknown> }>("select extra from relay_payment_refunds where idempotency_key='refund-partial'");
  assert.deepEqual(storedPartial.rows[0]?.extra, { allocationSource: "credit", taxAllocation: "checkout_cumulative_proportional_v1" });
  const partialReplay = await createStripeRefund({ orderId, amountMinor: 1000, reason: "QA partial refund", idempotencyKey: "refund-partial", actor: "admin" }, { env, db, fetcher: partialFetch });
  assert.equal(partialReplay.replay, true);

  const finalFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const held = await pg.query<{ reserved_minor: bigint }>("select reserved_minor from relay_tenants where id=$1", [owner.tenantId]);
    assert.equal(Number(held.rows[0]?.reserved_minor), 1500);
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("amount"), "1650");
    return Response.json({ id: "re_test_refund_final", amount: 1650, status: "succeeded" });
  }) as typeof fetch;
  const result = await createStripeRefund({ orderId, amountMinor: 1500, reason: "QA final refund", idempotencyKey: "refund-final", actor: "admin" }, { env, db, fetcher: finalFetch });
  assert.equal(result.replay, false);
  tenant = await pg.query<{ balance_minor: bigint; reserved_minor: bigint }>("select balance_minor,reserved_minor from relay_tenants where id=$1", [owner.tenantId]);
  assert.equal(Number(tenant.rows[0]?.balance_minor), 0);
  assert.equal(Number(tenant.rows[0]?.reserved_minor), 0);
  order = await pg.query<{ status: string; refunded_minor: bigint; refunded_tax_minor: bigint; refunded_gross_minor: bigint }>("select status,refunded_minor,refunded_tax_minor,refunded_gross_minor from relay_orders where id=$1", [orderId]);
  assert.equal(order.rows[0]?.status, "refunded");
  assert.equal(Number(order.rows[0]?.refunded_minor), 2500);
  assert.equal(Number(order.rows[0]?.refunded_tax_minor), 250);
  assert.equal(Number(order.rows[0]?.refunded_gross_minor), 2750);
  const balanced = await pg.query<{ total: bigint }>("select coalesce(sum(amount_minor),0)::bigint as total from relay_billing_entries where tenant_id=$1", [owner.tenantId]);
  assert.equal(Number(balanced.rows[0]?.total), 0);
  const accounts = await pg.query<{ account_code: string; amount: bigint }>("select account_code,sum(amount_minor)::bigint as amount from relay_billing_entries where tenant_id=$1 group by account_code order by account_code", [owner.tenantId]);
  assert.deepEqual(accounts.rows.map((row) => [row.account_code, Number(row.amount)]), [
    ["external_settlement", 0], ["tax_payable", 0], ["tenant_wallet", 0],
  ]);
  const replay = await createStripeRefund({ orderId, amountMinor: 1500, reason: "QA final refund", idempotencyKey: "refund-final", actor: "admin" }, { env, db, fetcher: finalFetch });
  assert.equal(replay.replay, true);
  await pg.close();
});

test("webhook route preserves the raw request body and never trusts browser success redirects", async () => {
  const route = await readFile("src/routes/api/webhooks/stripe.ts", "utf8");
  assert.match(route, /await request\.text\(\)/);
  assert.doesNotMatch(route, /request\.json\(\)/);
  const payments = await readFile("src/lib/payments.ts", "utf8");
  assert.match(payments, /payment_status\) === "paid"/);
  assert.match(payments, /stripe:payment:/);
  assert.match(payments, /payload_sha256/);
  assert.match(payments, /checkout_cumulative_proportional_v1/);
  assert.doesNotMatch(payments, /tax\/transactions\/create_reversal/);
  assert.doesNotMatch(payments, /insert into relay_payment_events[\s\S]{0,500}raw_body/i);
  const billingRoute = await readFile("src/routes/api/saas/billing.ts", "utf8");
  assert.match(billingRoute, /RELAY_ALLOW_MANUAL_CUSTOMER_ORDERS/);
});
