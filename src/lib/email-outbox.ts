import { createHash, createHmac } from "node:crypto";
import { assertPublicCommercialWebhookUrl, effectiveCommercialEnv } from "./commercial-config";
import { coordSetNx } from "./coord";
import { getSql, type Sql } from "./db";
import { decryptSecretValue, encryptSecretValue } from "./secrets";
import { uid } from "./utils";

type DbLike = Pick<Sql, "query">;
type Resolver = Parameters<typeof assertPublicCommercialWebhookUrl>[1];
type EmailKind = "verify-email" | "password-reset" | "tenant-invite";

type DeliveryRow = Record<string, unknown> & {
  id: string;
  attempts: number;
  payload_ciphertext: string;
  payload_sha256: string;
};

export type EmailDeliveryResult = {
  delivered: boolean;
  configured: boolean;
  status?: number;
  errorCode?: string;
};

function payloadHash(serialized: string) {
  return createHash("sha256").update(serialized).digest("hex");
}

function retryDelaySeconds(attempt: number) {
  return Math.min(3600, 60 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
}

export async function sendEmailWebhook(
  deliveryId: string,
  payload: Record<string, unknown>,
  opts: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; resolver?: Resolver; now?: Date } = {},
): Promise<EmailDeliveryResult> {
  const env = opts.env || process.env;
  const url = env.RELAY_EMAIL_WEBHOOK_URL?.trim() || "";
  if (!url) return { delivered: false, configured: false, errorCode: "EMAIL_WEBHOOK_NOT_CONFIGURED" };
  const secret = env.RELAY_EMAIL_WEBHOOK_SECRET?.trim() || "";
  if (secret.length < 32) return { delivered: false, configured: false, errorCode: "EMAIL_WEBHOOK_SECRET_INVALID" };
  let endpoint: string;
  try {
    const resolver = opts.resolver || (opts.fetcher ? async () => [{ address: "8.8.8.8", family: 4 }] : undefined);
    endpoint = await assertPublicCommercialWebhookUrl(url, resolver);
  } catch {
    return { delivered: false, configured: false, errorCode: "EMAIL_WEBHOOK_URL_INVALID" };
  }
  const body = JSON.stringify(payload);
  const timestamp = Math.floor((opts.now || new Date()).getTime() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  try {
    const response = await (opts.fetcher || fetch)(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Email-Id": deliveryId,
        "X-Relay-Timestamp": timestamp,
        "X-Relay-Signature": `v1=${signature}`,
      },
      signal: AbortSignal.timeout(10_000),
      body,
    });
    return response.ok
      ? { delivered: true, configured: true, status: response.status }
      : { delivered: false, configured: true, status: response.status, errorCode: "EMAIL_WEBHOOK_HTTP_ERROR" };
  } catch {
    return { delivered: false, configured: true, errorCode: "EMAIL_WEBHOOK_NETWORK_ERROR" };
  }
}

export async function queueEmailDelivery(
  input: {
    dedupeKey: string;
    kind: EmailKind;
    to: string;
    payload: Record<string, unknown>;
    expiresAt: string;
    supersedePrefix?: string;
  },
  db?: DbLike,
  opts: {
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    resolver?: Resolver;
    acquireLock?: (id: string) => Promise<boolean>;
  } = {},
) {
  const sql = db || await getSql();
  const env = opts.env || await effectiveCommercialEnv(process.env, sql);
  const key = env.RELAY_SECRETS_KEY?.trim() || "";
  if (key.length < 32) throw new Error("EMAIL_OUTBOX_ENCRYPTION_KEY_REQUIRED");
  const serialized = JSON.stringify(input.payload);
  if (Buffer.byteLength(serialized, "utf8") > 20_000) throw new Error("EMAIL_OUTBOX_PAYLOAD_TOO_LARGE");
  const ciphertext = encryptSecretValue(serialized, env);
  if (!ciphertext.startsWith("enc:v1:")) throw new Error("EMAIL_OUTBOX_ENCRYPTION_REQUIRED");
  const id = uid();
  if (input.supersedePrefix) {
    await sql.query(
      `update relay_email_deliveries set status='superseded',payload_ciphertext='[SUPERSEDED]',claim_expires_at=null,
         error_code='EMAIL_DELIVERY_SUPERSEDED',updated_at=now()
        where dedupe_key like $1 and status in ('pending','retrying','not_configured','sending')`,
      [`${input.supersedePrefix.replace(/[%_]/g, "")}:%`],
    );
  }
  const rows = await sql.query<{ id: string }>(
    `insert into relay_email_deliveries
      (id,dedupe_key,kind,status,attempts,recipient_hmac,payload_ciphertext,payload_sha256,next_attempt_at,expires_at,created_at,updated_at)
     values ($1,$2,$3,'pending',0,$4,$5,$6,now(),$7,now(),now())
     on conflict(dedupe_key) do nothing returning id`,
    [id, input.dedupeKey.slice(0, 240), input.kind,
      createHmac("sha256", key).update(input.to.trim().toLowerCase()).digest("hex"),
      ciphertext, payloadHash(serialized), input.expiresAt],
  );
  const deliveryId = rows[0]?.id || (await sql.query<{ id: string }>("select id from relay_email_deliveries where dedupe_key=$1", [input.dedupeKey]))[0]?.id;
  if (!deliveryId) throw new Error("EMAIL_OUTBOX_ENQUEUE_FAILED");
  await deliverDueEmailNotifications(sql, {
    env,
    fetcher: opts.fetcher,
    resolver: opts.resolver,
    acquireLock: opts.acquireLock,
    onlyId: deliveryId,
  });
  const state = await sql.query<{ status: string }>("select status from relay_email_deliveries where id=$1", [deliveryId]);
  return { id: deliveryId, status: state[0]?.status || "pending" };
}

export async function deliverDueEmailNotifications(
  db?: DbLike,
  opts: {
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    resolver?: Resolver;
    acquireLock?: (id: string) => Promise<boolean>;
    deliver?: (id: string, payload: Record<string, unknown>) => Promise<EmailDeliveryResult>;
    onlyId?: string;
    limit?: number;
  } = {},
) {
  const sql = db || await getSql();
  await sql.query(
    `update relay_email_deliveries set status='expired',payload_ciphertext='[EXPIRED]',claim_expires_at=null,
       error_code='EMAIL_DELIVERY_EXPIRED',updated_at=now()
      where status not in ('delivered','expired') and expires_at<=now()`,
  );
  await sql.query(
    `update relay_email_deliveries set status='retrying',claim_expires_at=null,next_attempt_at=now(),
       error_code='EMAIL_DELIVERY_CLAIM_EXPIRED',updated_at=now()
      where status='sending' and claim_expires_at<now()`,
  );
  const due = await sql.query<DeliveryRow>(
    `select * from relay_email_deliveries
      where status in ('pending','retrying','not_configured') and next_attempt_at<=now()
        and ($2::text is null or id=$2)
      order by next_attempt_at,created_at limit $1`,
    [Math.max(1, Math.min(100, Math.floor(opts.limit || 25))), opts.onlyId || null],
  );
  const env = opts.env || await effectiveCommercialEnv(process.env, sql);
  const deliver = opts.deliver || ((id: string, payload: Record<string, unknown>) => sendEmailWebhook(id, payload, {
    env, fetcher: opts.fetcher, resolver: opts.resolver,
  }));
  const acquireLock = opts.acquireLock || ((id: string) => coordSetNx(`email:delivery:${id}`, "1", 2 * 60_000).catch(() => true));
  let delivered = 0;
  let failed = 0;
  for (const row of due) {
    if (!await acquireLock(row.id)) continue;
    const claimed = await sql.query<DeliveryRow>(
      `update relay_email_deliveries set status='sending',claim_expires_at=now()+interval '2 minutes',updated_at=now()
        where id=$1 and status in ('pending','retrying','not_configured') and next_attempt_at<=now() returning *`,
      [row.id],
    );
    const delivery = claimed[0];
    if (!delivery) continue;
    let serialized: string;
    let payload: Record<string, unknown>;
    try {
      serialized = decryptSecretValue(String(delivery.payload_ciphertext), env);
      payload = JSON.parse(serialized) as Record<string, unknown>;
    } catch {
      await sql.query(
        `update relay_email_deliveries set status='retrying',claim_expires_at=null,next_attempt_at=now()+interval '1 hour',
           error_code='EMAIL_PAYLOAD_DECRYPT_FAILED',updated_at=now() where id=$1 and status='sending'`,
        [delivery.id],
      );
      failed += 1;
      continue;
    }
    if (payloadHash(serialized) !== String(delivery.payload_sha256)) {
      await sql.query(
        `update relay_email_deliveries set status='retrying',claim_expires_at=null,next_attempt_at=now()+interval '1 hour',
           error_code='EMAIL_PAYLOAD_HASH_MISMATCH',updated_at=now() where id=$1 and status='sending'`,
        [delivery.id],
      );
      failed += 1;
      continue;
    }
    const result = await deliver(delivery.id, payload).catch(() => ({
      delivered: false, configured: true, errorCode: "EMAIL_DELIVERY_ERROR",
    } as EmailDeliveryResult));
    if (!result.configured) {
      await sql.query(
        `update relay_email_deliveries set status='not_configured',claim_expires_at=null,next_attempt_at=now()+interval '5 minutes',
           http_status=null,error_code=$2,updated_at=now() where id=$1 and status='sending'`,
        [delivery.id, result.errorCode || "EMAIL_WEBHOOK_NOT_CONFIGURED"],
      );
      continue;
    }
    const attempt = Number(delivery.attempts || 0) + 1;
    if (result.delivered) {
      await sql.query(
        `update relay_email_deliveries set status='delivered',attempts=$2,last_attempt_at=now(),delivered_at=now(),
           payload_ciphertext='[DELIVERED]',claim_expires_at=null,http_status=$3,error_code=null,updated_at=now()
          where id=$1 and status='sending'`,
        [delivery.id, attempt, result.status || 200],
      );
      delivered += 1;
    } else {
      await sql.query(
        `update relay_email_deliveries set status='retrying',attempts=$2,last_attempt_at=now(),claim_expires_at=null,
           next_attempt_at=now()+($3::text||' seconds')::interval,http_status=$4,error_code=$5,updated_at=now()
          where id=$1 and status='sending'`,
        [delivery.id, attempt, retryDelaySeconds(attempt), result.status || null, result.errorCode || "EMAIL_DELIVERY_FAILED"],
      );
      failed += 1;
    }
  }
  return { scanned: due.length, delivered, failed };
}

export async function retryEmailDeliveriesNow(db?: DbLike) {
  const sql = db || await getSql();
  await sql.query("update relay_email_deliveries set next_attempt_at=now(),updated_at=now() where status in ('pending','retrying','not_configured')");
  return deliverDueEmailNotifications(sql);
}
