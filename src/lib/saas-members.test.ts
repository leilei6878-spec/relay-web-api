import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createTenantOwner } from "./saas-billing.ts";
import { acceptTenantInvite, inviteTenantMember, listTenantMembers, updateTenantMemberRole } from "./saas-members.ts";
import type { SaasSession } from "./saas-auth.ts";

async function database() {
  const pg = new PGlite(); await pg.waitReady;
  for (const name of ["0001_relay.sql","0002_relay_ops.sql","0003_relay_production.sql","0004_schema_meta.sql","0005_account_operations.sql","0006_account_availability_samples.sql","0007_commercial_saas.sql","0008_commercial_payments.sql","0009_commercial_config.sql","0010_provider_sandbox.sql","0011_commercial_launch_evidence.sql"]) await pg.exec(await readFile(`migrations/${name}`, "utf8"));
  return { pg, db: { query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows } };
}

test("tenant invitations are hash-only, email-delivered and atomically accepted", async () => {
  const { pg, db } = await database();
  const owner = await createTenantOwner({ tenantName: "Members Co", ownerName: "Owner", email: "owner@members.test", password: "members-password-123" }, db);
  const session = { userId: owner.userId, tenantId: owner.tenantId, email: owner.email, name: "Owner", tenantName: "Members Co", tenantStatus: "active", role: "owner", sessionId: "s", csrfHash: "x", expiresAt: "" } satisfies SaasSession;
  let link = "";
  await inviteTenantMember(session, { email: "developer@members.test", role: "developer" }, {
    db,
    env: { RELAY_EMAIL_WEBHOOK_URL: "https://mail.test", RELAY_PUBLIC_URL: "https://relay.test" } as NodeJS.ProcessEnv,
    fetcher: async (_url, init) => { link = JSON.parse(String(init?.body)).link; return Response.json({ ok: true }); },
  });
  const stored = await pg.query<Record<string, unknown>>("select * from relay_tenant_invites");
  const token = new URL(link).searchParams.get("token") || "";
  assert.ok(token);
  assert.ok(!JSON.stringify(stored.rows).includes(token));
  const accepted = await acceptTenantInvite({ token, name: "Developer", password: "developer-password-123" }, db);
  assert.equal(accepted.tenantId, owner.tenantId);
  const members = await listTenantMembers(owner.tenantId, db);
  assert.equal(members.length, 2);
  assert.ok(members.some((member) => member.role === "developer"));
  await assert.rejects(() => updateTenantMemberRole(session, owner.userId, "viewer", "active", db), /LAST_OWNER_REQUIRED/);
  await pg.close();
});
