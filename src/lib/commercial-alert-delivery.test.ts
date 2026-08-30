import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  deliverDueAlertNotifications,
  persistCommercialSignals,
  retryAlertDeliveriesNow,
  sendAlertWebhook,
  type AlertDeliveryResult,
} from "./commercial-monitor.ts";

async function database() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of ["0001_relay.sql", "0004_schema_meta.sql", "0007_commercial_saas.sql", "0016_alert_delivery_outbox.sql"]) {
    await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  }
  return {
    pg,
    db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows },
  };
}

const lock = async () => true;

test("signed alert webhook binds timestamp, body and stable delivery id without leaking its secret", async () => {
  const secret = "alert-signing-secret-0123456789abcdef";
  const now = new Date("2026-08-30T01:02:03.000Z");
  const payload = { source: "relay-saas", deliveryId: "delivery-1", event: "opened", code: "WORKER_ZERO" };
  let called = 0;
  const result = await sendAlertWebhook("delivery-1", payload, {
    env: { RELAY_ALERT_WEBHOOK_URL: "https://hooks.example.test/relay", RELAY_ALERT_WEBHOOK_SECRET: secret } as NodeJS.ProcessEnv,
    now,
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      called += 1;
      assert.equal(String(url), "https://hooks.example.test/relay");
      const body = String(init?.body);
      const headers = new Headers(init?.headers);
      const timestamp = String(Math.floor(now.getTime() / 1000));
      assert.equal(headers.get("x-relay-event-id"), "delivery-1");
      assert.equal(headers.get("x-relay-timestamp"), timestamp);
      assert.equal(
        headers.get("x-relay-signature"),
        `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`,
      );
      assert.ok(!body.includes(secret));
      assert.deepEqual(JSON.parse(body), payload);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  assert.deepEqual(result, { delivered: true, configured: true, status: 204 });
  assert.equal(called, 1);

  const invalid = await sendAlertWebhook("delivery-2", payload, {
    env: { RELAY_ALERT_WEBHOOK_URL: "https://hooks.example.test/relay", RELAY_ALERT_WEBHOOK_SECRET: "short" } as NodeJS.ProcessEnv,
    fetcher: (async () => { throw new Error("must not fetch"); }) as typeof fetch,
  });
  assert.equal(invalid.configured, false);
  assert.equal(invalid.errorCode, "ALERT_WEBHOOK_SECRET_INVALID");
});

test("alert outbox retries opening events, delivers recovery and sanitizes durable payloads", async () => {
  const { pg, db } = await database();
  const signal = {
    code: "WORKER_ZERO", severity: "critical" as const, message: "No worker is available",
    detail: { safe: "retained", password: "never-store", note: "sk-1234567890abcdef", contact: "person@example.test" },
  };
  let calls = 0;
  const failure = async () => {
    calls += 1;
    return { delivered: false, configured: true, status: 503, errorCode: "ALERT_WEBHOOK_HTTP_ERROR" } satisfies AlertDeliveryResult;
  };
  await persistCommercialSignals([signal], db, { deliver: failure, acquireLock: lock });
  assert.equal(calls, 1);
  let deliveries = await pg.query<Record<string, unknown>>("select * from relay_alert_deliveries order by created_at");
  assert.equal(deliveries.rows.length, 1);
  assert.equal(deliveries.rows[0]?.event_type, "opened");
  assert.equal(deliveries.rows[0]?.status, "retrying");
  assert.equal(deliveries.rows[0]?.attempts, 1);
  const serialized = JSON.stringify(deliveries.rows[0]?.payload);
  assert.doesNotMatch(serialized, /never-store|1234567890abcdef|person@example\.test/);
  assert.match(serialized, /retained|REDACTED/);

  await persistCommercialSignals([signal], db, { deliver: failure, acquireLock: lock });
  assert.equal(calls, 1, "backoff must suppress an immediate duplicate attempt");
  assert.equal((await pg.query<{ count: number }>("select count(*)::int as count from relay_alert_deliveries")).rows[0]?.count, 1);

  const success = async () => {
    calls += 1;
    return { delivered: true, configured: true, status: 202 } satisfies AlertDeliveryResult;
  };
  await retryAlertDeliveriesNow(db, { deliver: success, acquireLock: lock });
  deliveries = await pg.query<Record<string, unknown>>("select * from relay_alert_deliveries order by created_at");
  assert.equal(deliveries.rows[0]?.status, "delivered");
  assert.equal(deliveries.rows[0]?.attempts, 2);
  assert.equal(deliveries.rows[0]?.http_status, 202);

  await persistCommercialSignals([], db, { deliver: success, acquireLock: lock });
  deliveries = await pg.query<Record<string, unknown>>("select * from relay_alert_deliveries order by created_at");
  assert.deepEqual(deliveries.rows.map((row) => row.event_type), ["opened", "resolved"]);
  assert.ok(deliveries.rows.every((row) => row.status === "delivered"));
  assert.notEqual(deliveries.rows[0]?.id, deliveries.rows[1]?.id);
  const alert = await pg.query<{ status: string }>("select status from relay_alert_events where code='WORKER_ZERO'");
  assert.equal(alert.rows[0]?.status, "resolved");
  await pg.close();
});

test("unseen opening is superseded on fast recovery and expired claims have one database winner", async () => {
  const { pg, db } = await database();
  const signal = { code: "FAST_RECOVERY", severity: "warning" as const, message: "Transient condition" };
  await persistCommercialSignals([signal], db, {
    deliver: async () => ({ delivered: false, configured: false, errorCode: "ALERT_WEBHOOK_NOT_CONFIGURED" }),
    acquireLock: lock,
  });
  let delivery = await pg.query<Record<string, unknown>>("select * from relay_alert_deliveries where event_type='opened'");
  assert.equal(delivery.rows[0]?.status, "not_configured");
  assert.equal(delivery.rows[0]?.attempts, 0);
  let calls = 0;
  await persistCommercialSignals([], db, {
    deliver: async () => { calls += 1; return { delivered: true, configured: true, status: 200 }; },
    acquireLock: lock,
  });
  delivery = await pg.query<Record<string, unknown>>("select * from relay_alert_deliveries");
  assert.equal(delivery.rows[0]?.status, "superseded");
  assert.equal(calls, 0);
  assert.equal((await pg.query<{ count: number }>("select count(*)::int as count from relay_alert_deliveries where event_type='resolved'")).rows[0]?.count, 0);

  const live = { code: "CLAIM_RECOVERY", severity: "critical" as const, message: "Durable delivery" };
  await persistCommercialSignals([live], db, {
    deliver: async () => ({ delivered: false, configured: false, errorCode: "ALERT_WEBHOOK_NOT_CONFIGURED" }),
    acquireLock: lock,
  });
  await pg.query(
    "update relay_alert_deliveries set status='sending',claim_expires_at=now()-interval '1 minute' where event_type='opened' and status='not_configured'",
  );
  calls = 0;
  const deliver = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { delivered: true, configured: true, status: 200 } satisfies AlertDeliveryResult;
  };
  await Promise.all([
    deliverDueAlertNotifications(db, { deliver, acquireLock: lock }),
    deliverDueAlertNotifications(db, { deliver, acquireLock: lock }),
  ]);
  assert.equal(calls, 1);
  const claimed = await pg.query<Record<string, unknown>>("select * from relay_alert_deliveries where alert_id=(select id from relay_alert_events where code='CLAIM_RECOVERY')");
  assert.equal(claimed.rows[0]?.status, "delivered");
  assert.equal(claimed.rows[0]?.attempts, 1);

  const tampered = { code: "PAYLOAD_TAMPER", severity: "critical" as const, message: "Integrity check" };
  await persistCommercialSignals([tampered], db, {
    deliver: async () => ({ delivered: false, configured: false, errorCode: "ALERT_WEBHOOK_NOT_CONFIGURED" }),
    acquireLock: lock,
  });
  await pg.query(
    `update relay_alert_deliveries set payload=jsonb_set(payload,'{message}','"changed"'::jsonb),
       status='pending',next_attempt_at=now()
      where alert_id=(select id from relay_alert_events where code='PAYLOAD_TAMPER') and event_type='opened'`,
  );
  calls = 0;
  await deliverDueAlertNotifications(db, { deliver, acquireLock: lock });
  assert.equal(calls, 0, "payload hash mismatch must fail before network delivery");
  const rejected = await pg.query<Record<string, unknown>>(
    "select * from relay_alert_deliveries where alert_id=(select id from relay_alert_events where code='PAYLOAD_TAMPER') and event_type='opened'",
  );
  assert.equal(rejected.rows[0]?.status, "retrying");
  assert.equal(rejected.rows[0]?.error_code, "ALERT_DELIVERY_PAYLOAD_HASH_MISMATCH");
  await pg.close();
});

test("manual delivery retry remains behind administrator MFA and is visible in operations", async () => {
  const route = await readFile("src/routes/api/admin/commercial.ts", "utf8");
  const page = await readFile("src/routes/commercial.tsx", "utf8");
  const snapshot = await readFile("src/lib/saas-billing.ts", "utf8");
  assert.match(route, /assertAdminMfa\(request\)/);
  assert.match(route, /retry-alert-deliveries/);
  assert.match(route, /retryAlertDeliveriesNow/);
  assert.match(page, /立即重试投递/);
  assert.match(page, /delivery_status/);
  assert.match(snapshot, /relay_alert_deliveries/);
});
