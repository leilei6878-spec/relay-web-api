import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  cancelTenantClosure,
  createTenantDataExport,
  listTenantPrivacyRequests,
  processDueTenantClosures,
  requestTenantClosure,
} from "./saas-privacy.ts";
import { sha256 } from "./saas-crypto.ts";

async function database() {
  const pg = new PGlite(); await pg.waitReady;
  const files = (await readdir("migrations")).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of files) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  const db = { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows };
  return { pg, db };
}

async function tenant(pg: PGlite, suffix: string, balance = 0) {
  const tenantId = `privacy-tenant-${suffix}`;
  const userId = `privacy-user-${suffix}`;
  const email = `owner-${suffix}@example.test`;
  await pg.query(
    `insert into relay_tenants(id,slug,name,billing_email,balance_minor)
     values ($1,$2,$3,$4,$5)`,
    [tenantId, tenantId, `Privacy ${suffix}`, email, balance],
  );
  await pg.query(
    `insert into relay_saas_users(id,email,email_normalized,name,password_hash,mfa_enabled)
     values ($1,$2,$2,$3,$4,true)`,
    [userId, email, `Owner ${suffix}`, `secret-password-hash-${suffix}`],
  );
  await pg.query(
    `insert into relay_tenant_memberships(tenant_id,user_id,role,status)
     values ($1,$2,'owner','active')`,
    [tenantId, userId],
  );
  return { tenantId, userId, email };
}

test("tenant export is complete, tenant-scoped, hash-bound and omits credential/network secrets", async () => {
  const { pg, db } = await database();
  const a = await tenant(pg, "a");
  const b = await tenant(pg, "b");
  await pg.query(
    `insert into relay_tenant_api_keys(id,tenant_id,name,key_hash,key_prefix,key_hint,created_by)
     values ('privacy-key-a',$1,'Production',$2,'sk-saas','sk-saas…abcd',$3)`,
    [a.tenantId, sha256("sk-saas-secret-value"), a.userId],
  );
  await pg.query(
    `insert into relay_usage_charges
      (id,tenant_id,request_id,provider,model,capability,status,extra)
     values ('privacy-charge-a',$1,'privacy-request-a','openai','gpt-test','chat','settled',$2::jsonb)`,
    [a.tenantId, JSON.stringify({ providerResultCiphertext: "encrypted-provider-secret", safe: "not exported either" })],
  );
  const exported = await createTenantDataExport(a.tenantId, a.userId, { RELAY_PRIVACY_EXPORT_MAX_MIB: "5" } as NodeJS.ProcessEnv, db);
  const text = exported.bytes.toString("utf8");
  assert.equal(sha256(text), exported.sha256);
  assert.match(text, new RegExp(a.email));
  assert.doesNotMatch(text, new RegExp(b.email));
  assert.doesNotMatch(text, /secret-password-hash|sk-saas-secret-value|encrypted-provider-secret|key_hash|password_hash|ip_hmac|user_agent_hmac/);
  assert.equal(exported.payload.schema, "relay-tenant-export-v1");
  const stored = await pg.query<{ status: string; snapshot_sha256: string }>("select status,snapshot_sha256 from relay_privacy_requests where id=$1", [exported.request?.id]);
  assert.deepEqual(stored.rows, [{ status: "completed", snapshot_sha256: exported.sha256 }]);
  const event = await pg.query<{ event_type: string; payload_sha256: string }>("select event_type,payload_sha256 from relay_privacy_request_events where request_id=$1", [exported.request?.id]);
  assert.deepEqual(event.rows, [{ event_type: "exported", payload_sha256: exported.sha256 }]);
  await pg.close();
});

test("closure request is idempotent during cooling-off, owner-cancelable and terminal", async () => {
  const { pg, db } = await database();
  const a = await tenant(pg, "cancel");
  const first = await requestTenantClosure(a.tenantId, a.userId, { RELAY_TENANT_CLOSURE_GRACE_DAYS: "3" } as NodeJS.ProcessEnv, db);
  const replay = await requestTenantClosure(a.tenantId, a.userId, { RELAY_TENANT_CLOSURE_GRACE_DAYS: "3" } as NodeJS.ProcessEnv, db);
  assert.equal(replay.id, first.id);
  assert.equal((await listTenantPrivacyRequests(a.tenantId, db)).filter((row) => row.kind === "tenant_closure").length, 1);
  const cancelled = await cancelTenantClosure(a.tenantId, a.userId, String(first.id), db);
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(() => cancelTenantClosure(a.tenantId, a.userId, String(first.id), db), /NOT_CANCELABLE/);
  await assert.rejects(() => pg.query("update relay_privacy_requests set status='requested',cancelled_at=null where id=$1", [first.id]), /terminal/);
  await assert.rejects(() => pg.query("delete from relay_privacy_requests where id=$1", [first.id]), /cannot be deleted/);
  await pg.close();
});

test("due closure blocks on money, then atomically revokes access and pseudonymizes an exclusive user", async () => {
  const { pg, db } = await database();
  const a = await tenant(pg, "close", 100);
  await pg.query(
    `insert into relay_tenant_api_keys(id,tenant_id,name,key_hash,key_prefix,key_hint,created_by)
     values ('privacy-close-key',$1,'Production',$2,'sk-saas','sk-saas…close',$3)`,
    [a.tenantId, sha256("close-key"), a.userId],
  );
  await pg.query(
    `insert into relay_saas_sessions(id,user_id,tenant_id,token_hash,csrf_hash,expires_at,mfa_verified_at)
     values ('privacy-close-session',$1,$2,$3,$4,now()+interval '1 day',now())`,
    [a.userId, a.tenantId, sha256("session"), sha256("csrf")],
  );
  await pg.query(
    `insert into relay_tenant_invites(id,tenant_id,email,email_normalized,role,token_hash,invited_by,expires_at)
     values ('privacy-close-invite',$1,'invitee@example.test','invitee@example.test','viewer',$2,$3,now()+interval '1 day')`,
    [a.tenantId, sha256("invite-token"), a.userId],
  );
  await pg.query(
    `insert into relay_email_deliveries
      (id,dedupe_key,kind,status,attempts,recipient_hmac,payload_ciphertext,payload_sha256,next_attempt_at,expires_at)
     values ('privacy-close-email',$1,'tenant-invite','pending',0,$2,'encrypted-invite-payload',$2,now(),now()+interval '1 day')`,
    [`tenant-invite:${a.tenantId}:recipient`, "a".repeat(64)],
  );
  await pg.query(
    `insert into relay_privacy_requests(id,tenant_id,requested_by,kind,status,due_at)
     values ('privacy-close-request',$1,$2,'tenant_closure','requested',now())`,
    [a.tenantId, a.userId],
  );
  const blocked = await processDueTenantClosures(db);
  assert.deepEqual(blocked, { examined: 1, completed: 0, blocked: 1 });
  assert.equal((await pg.query<{ status: string; blocked_reason: string }>("select status,blocked_reason from relay_privacy_requests where id='privacy-close-request'")).rows[0]?.blocked_reason, "BALANCE_NOT_ZERO");
  await pg.query("update relay_tenants set balance_minor=0 where id=$1", [a.tenantId]);
  const completed = await processDueTenantClosures(db);
  assert.deepEqual(completed, { examined: 1, completed: 1, blocked: 0 });
  const state = await pg.query<{ tenant_status: string; user_status: string; email: string; membership_status: string; key_enabled: boolean; revoked_at: string | null }>(
    `select t.status as tenant_status,u.status as user_status,u.email,m.status as membership_status,k.enabled as key_enabled,s.revoked_at
       from relay_tenants t join relay_tenant_memberships m on m.tenant_id=t.id
       join relay_saas_users u on u.id=m.user_id join relay_tenant_api_keys k on k.tenant_id=t.id
       join relay_saas_sessions s on s.tenant_id=t.id where t.id=$1`,
    [a.tenantId],
  );
  assert.equal(state.rows[0]?.tenant_status, "closed");
  assert.equal(state.rows[0]?.user_status, "closed");
  assert.match(state.rows[0]?.email || "", /^closed\+/);
  assert.equal(state.rows[0]?.membership_status, "disabled");
  assert.equal(state.rows[0]?.key_enabled, false);
  assert.ok(state.rows[0]?.revoked_at);
  const scrubbed = await pg.query<{ invite_email: string; payload_ciphertext: string }>(
    `select i.email as invite_email,d.payload_ciphertext from relay_tenant_invites i
      join relay_email_deliveries d on d.id='privacy-close-email' where i.id='privacy-close-invite'`,
  );
  assert.match(scrubbed.rows[0]?.invite_email || "", /^closed\+/);
  assert.equal(scrubbed.rows[0]?.payload_ciphertext, "[PRIVACY_CLOSED]");
  const events = await pg.query<{ event_type: string }>("select event_type from relay_privacy_request_events where request_id='privacy-close-request' order by created_at,id");
  assert.deepEqual(events.rows.map((row) => row.event_type).sort(), ["blocked", "completed"]);
  await assert.rejects(() => pg.query("delete from relay_privacy_request_events where request_id='privacy-close-request'"), /append-only/);
  await pg.close();
});

test("closing one tenant preserves a user profile that still belongs to another active tenant", async () => {
  const { pg, db } = await database();
  const closing = await tenant(pg, "shared-close");
  const remaining = await tenant(pg, "shared-live");
  await pg.query(
    "insert into relay_tenant_memberships(tenant_id,user_id,role,status) values ($1,$2,'viewer','active')",
    [remaining.tenantId, closing.userId],
  );
  await pg.query(
    `insert into relay_privacy_requests(id,tenant_id,requested_by,kind,status,due_at)
     values ('privacy-shared-request',$1,$2,'tenant_closure','requested',now())`,
    [closing.tenantId, closing.userId],
  );
  assert.deepEqual(await processDueTenantClosures(db), { examined: 1, completed: 1, blocked: 0 });
  const user = await pg.query<{ email: string; status: string }>("select email,status from relay_saas_users where id=$1", [closing.userId]);
  assert.deepEqual(user.rows, [{ email: closing.email, status: "active" }]);
  const membership = await pg.query<{ status: string }>("select status from relay_tenant_memberships where tenant_id=$1 and user_id=$2", [remaining.tenantId, closing.userId]);
  assert.deepEqual(membership.rows, [{ status: "active" }]);
  await pg.close();
});

test("privacy endpoint requires owner, CSRF and unconditional recent MFA", async () => {
  const source = await readFile("src/routes/api/saas/privacy.ts", "utf8");
  assert.match(source, /assertSaasSession\(request, \["owner"\], \{ requireCsrf: true, forceMfa: true, requireLegal: false, allowSuspended: true \}\)/);
  assert.match(source, /assertSaasSession\(request, \["owner"\], \{ requireLegal: false, allowSuspended: true \}\)/);
  assert.match(source, /X-Relay-Export-SHA256/);
  assert.match(source, /Content-Disposition/);
  const page = await readFile("src/routes/saas/privacy-center.tsx", "utf8");
  const consent = await readFile("src/routes/saas/consent.tsx", "utf8");
  const session = await readFile("src/routes/api/saas/session.ts", "utf8");
  assert.match(page, /无需接受新版条款即可使用/);
  assert.match(consent, /href="\/saas\/privacy-center"/);
  assert.match(session, /\["owner", "admin"\], \{ requireCsrf: true, requireLegal: false, allowSuspended: true \}/);
});
