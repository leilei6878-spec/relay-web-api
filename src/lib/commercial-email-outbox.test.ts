import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  deliverDueEmailNotifications,
  queueEmailDelivery,
  sendEmailWebhook,
  type EmailDeliveryResult,
} from "./email-outbox.ts";

async function database() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of ["0001_relay.sql", "0004_schema_meta.sql", "0007_commercial_saas.sql", "0017_email_delivery_outbox.sql"]) {
    await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  }
  return {
    pg,
    db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows },
  };
}

const env = {
  NODE_ENV: "test",
  RELAY_SECRETS_KEY: "email-outbox-encryption-key-0123456789abcdef",
  RELAY_EMAIL_WEBHOOK_URL: "https://mail.example.test/relay",
  RELAY_EMAIL_WEBHOOK_SECRET: "email-webhook-signing-key-0123456789abcdef",
} as NodeJS.ProcessEnv;
const lock = async () => true;

test("email webhook signs exact body and stable mail id", async () => {
  const now = new Date("2026-08-30T03:00:00.000Z");
  const payload = { template: "verify-email", to: "person@example.test", link: "https://relay.example.test/verify?token=secret" };
  const result = await sendEmailWebhook("mail-1", payload, {
    env,
    now,
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    fetcher: (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const timestamp = String(Math.floor(now.getTime() / 1000));
      const body = String(init?.body || "");
      assert.equal(headers.get("x-relay-email-id"), "mail-1");
      assert.equal(headers.get("x-relay-timestamp"), timestamp);
      assert.equal(headers.get("x-relay-signature"), `v1=${createHmac("sha256", env.RELAY_EMAIL_WEBHOOK_SECRET!).update(`${timestamp}.${body}`).digest("hex")}`);
      assert.deepEqual(JSON.parse(body), payload);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  assert.deepEqual(result, { delivered: true, configured: true, status: 204 });
});

test("encrypted email outbox retries then scrubs recipient and token payload after delivery", async () => {
  const { pg, db } = await database();
  const payload = { template: "verify-email", to: "private@example.test", link: "https://relay.example.test/verify?token=raw-secret-token" };
  let calls = 0;
  const first = await queueEmailDelivery({
    dedupeKey: "verify-email:user-1:message-1", supersedePrefix: "verify-email:user-1",
    kind: "verify-email", to: "private@example.test", payload,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }, db, {
    env,
    acquireLock: lock,
    fetcher: (async () => { calls += 1; return new Response(null, { status: 503 }); }) as typeof fetch,
  });
  assert.equal(first.status, "retrying");
  assert.equal(calls, 1);
  let row = (await pg.query<Record<string, unknown>>("select * from relay_email_deliveries where id=$1", [first.id])).rows[0]!;
  assert.match(String(row.payload_ciphertext), /^enc:v1:/);
  assert.equal(row.attempts, 1);
  assert.ok(!JSON.stringify(row).includes("private@example.test"));
  assert.ok(!JSON.stringify(row).includes("raw-secret-token"));
  assert.match(String(row.recipient_hmac), /^[0-9a-f]{64}$/);

  await deliverDueEmailNotifications(db, { env, acquireLock: lock, deliver: async () => { calls += 1; return { delivered: true, configured: true, status: 202 }; } });
  assert.equal(calls, 1, "backoff must suppress immediate duplicate delivery");
  await pg.query("update relay_email_deliveries set next_attempt_at=now() where id=$1", [first.id]);
  let deliveredPayload: Record<string, unknown> = {};
  await deliverDueEmailNotifications(db, {
    env,
    acquireLock: lock,
    deliver: async (_id, value) => { calls += 1; deliveredPayload = value; return { delivered: true, configured: true, status: 202 }; },
  });
  assert.deepEqual(deliveredPayload, payload);
  row = (await pg.query<Record<string, unknown>>("select * from relay_email_deliveries where id=$1", [first.id])).rows[0]!;
  assert.equal(row.status, "delivered");
  assert.equal(row.attempts, 2);
  assert.equal(row.payload_ciphertext, "[DELIVERED]");
  await pg.close();
});

test("new token supersedes queued ciphertext, expiry scrubs it and concurrent claims send once", async () => {
  const { pg, db } = await database();
  const noEndpoint = { NODE_ENV: "test", RELAY_SECRETS_KEY: env.RELAY_SECRETS_KEY } as NodeJS.ProcessEnv;
  const first = await queueEmailDelivery({
    dedupeKey: "password-reset:user-1:first", supersedePrefix: "password-reset:user-1",
    kind: "password-reset", to: "reset@example.test", payload: { template: "password-reset", to: "reset@example.test", link: "https://relay/reset?token=first" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, db, { env: noEndpoint, acquireLock: lock });
  assert.equal(first.status, "not_configured");
  const replay = await queueEmailDelivery({
    dedupeKey: "password-reset:user-1:first", supersedePrefix: "password-reset:user-1",
    kind: "password-reset", to: "reset@example.test", payload: { template: "password-reset", to: "reset@example.test", link: "https://relay/reset?token=first" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, db, { env: noEndpoint, acquireLock: lock });
  assert.deepEqual(replay, first, "an idempotent enqueue replay must not supersede its own durable row");
  assert.equal((await pg.query("select id from relay_email_deliveries")).rows.length, 1);
  const second = await queueEmailDelivery({
    dedupeKey: "password-reset:user-1:second", supersedePrefix: "password-reset:user-1",
    kind: "password-reset", to: "reset@example.test", payload: { template: "password-reset", to: "reset@example.test", link: "https://relay/reset?token=second" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, db, { env: noEndpoint, acquireLock: lock });
  const rows = await pg.query<Record<string, unknown>>("select * from relay_email_deliveries order by created_at");
  assert.equal(rows.rows[0]?.status, "superseded");
  assert.equal(rows.rows[0]?.payload_ciphertext, "[SUPERSEDED]");
  assert.equal(rows.rows[1]?.status, "not_configured");

  await pg.query("update relay_email_deliveries set expires_at=now()-interval '1 minute' where id=$1", [second.id]);
  await deliverDueEmailNotifications(db, { env: noEndpoint, acquireLock: lock });
  const expired = (await pg.query<Record<string, unknown>>("select * from relay_email_deliveries where id=$1", [second.id])).rows[0]!;
  assert.equal(expired.status, "expired");
  assert.equal(expired.payload_ciphertext, "[EXPIRED]");

  const third = await queueEmailDelivery({
    dedupeKey: "tenant-invite:invite-1:third", supersedePrefix: "tenant-invite:invite-1",
    kind: "tenant-invite", to: "invite@example.test", payload: { template: "tenant-invite", to: "invite@example.test", link: "https://relay/invite?token=third" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, db, { env: noEndpoint, acquireLock: lock });
  await pg.query("update relay_email_deliveries set status='sending',claim_expires_at=now()-interval '1 minute' where id=$1", [third.id]);
  let calls = 0;
  const deliver = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { delivered: true, configured: true, status: 200 } satisfies EmailDeliveryResult;
  };
  await Promise.all([
    deliverDueEmailNotifications(db, { env, acquireLock: lock, deliver }),
    deliverDueEmailNotifications(db, { env, acquireLock: lock, deliver }),
  ]);
  assert.equal(calls, 1);
  assert.equal((await pg.query<{ status: string }>("select status from relay_email_deliveries where id=$1", [third.id])).rows[0]?.status, "delivered");
  await pg.close();
});
