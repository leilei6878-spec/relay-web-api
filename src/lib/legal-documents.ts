import { createHash, createHmac } from "node:crypto";
import { trustedClientIp } from "./client-network";
import { LEGAL_CONTENT_REVISION, LEGAL_PRIVACY_SECTIONS, LEGAL_TERMS_SECTIONS, type LegalPublicMetadata } from "./legal-content";
import { uid } from "./utils";
import { effectiveCommercialEnv } from "./commercial-config";
import { getSql, type Sql } from "./db";

type DbLike = Pick<Sql, "query">;

export type LegalDocumentMetadata = LegalPublicMetadata;

export type PreparedLegalAcceptance = {
  id: string;
  termsVersion: string;
  privacyVersion: string;
  bundleSha256: string;
  ipHmac: string;
  userAgentHmac: string;
  method: "registration" | "invite" | "reconsent";
};

function bounded(value: string | undefined, max: number) {
  return (value || "").trim().slice(0, max);
}

function validUtcDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function legalDocumentMetadata(env: NodeJS.ProcessEnv = process.env): LegalDocumentMetadata {
  const operatorName = bounded(env.RELAY_LEGAL_OPERATOR_NAME, 200);
  const contactEmail = bounded(env.RELAY_LEGAL_CONTACT_EMAIL, 320).toLowerCase();
  const termsVersion = bounded(env.RELAY_TERMS_VERSION, 80);
  const privacyVersion = bounded(env.RELAY_PRIVACY_VERSION, 80);
  const effectiveDate = bounded(env.RELAY_LEGAL_EFFECTIVE_DATE, 10);
  const configured = operatorName.length >= 2 && /^\S+@\S+\.\S+$/.test(contactEmail) &&
    /^[A-Za-z0-9._-]{1,80}$/.test(termsVersion) && /^[A-Za-z0-9._-]{1,80}$/.test(privacyVersion) &&
    validUtcDate(effectiveDate);
  const canonical = JSON.stringify({
    operatorName, contactEmail, termsVersion, privacyVersion, effectiveDate,
    contentRevision: LEGAL_CONTENT_REVISION,
    terms: LEGAL_TERMS_SECTIONS,
    privacy: LEGAL_PRIVACY_SECTIONS,
  });
  return {
    configured,
    approved: configured && env.RELAY_LEGAL_APPROVED === "1",
    operatorName,
    contactEmail,
    termsVersion,
    privacyVersion,
    effectiveDate,
    contentRevision: LEGAL_CONTENT_REVISION,
    bundleSha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

export function prepareLegalAcceptance(
  input: { accepted?: boolean; termsVersion?: string; privacyVersion?: string; bundleSha256?: string; method: "registration" | "invite" | "reconsent" },
  request: Request,
  env: NodeJS.ProcessEnv,
): PreparedLegalAcceptance | null {
  const required = env.NODE_ENV === "production" || env.RELAY_REQUIRE_LEGAL_ACCEPTANCE === "1";
  if (!required) return null;
  const metadata = legalDocumentMetadata(env);
  if (!metadata.configured) throw new Error("LEGAL_DOCUMENTS_NOT_CONFIGURED");
  if (!metadata.approved) throw new Error("LEGAL_DOCUMENTS_NOT_APPROVED");
  if (!input.accepted) throw new Error("LEGAL_ACCEPTANCE_REQUIRED");
  if (input.termsVersion !== metadata.termsVersion || input.privacyVersion !== metadata.privacyVersion || input.bundleSha256 !== metadata.bundleSha256) {
    throw new Error("LEGAL_DOCUMENT_VERSION_STALE");
  }
  const key = env.RELAY_AUDIT_HASH_KEY?.trim() || env.RELAY_SECRETS_KEY?.trim() || "";
  if (key.length < 32) throw new Error("LEGAL_ACCEPTANCE_HMAC_KEY_REQUIRED");
  const ip = trustedClientIp(request, env);
  const userAgent = (request.headers.get("user-agent") || "unknown").slice(0, 1024);
  return {
    id: uid(),
    termsVersion: metadata.termsVersion,
    privacyVersion: metadata.privacyVersion,
    bundleSha256: metadata.bundleSha256,
    ipHmac: createHmac("sha256", key).update(ip).digest("hex"),
    userAgentHmac: createHmac("sha256", key).update(userAgent).digest("hex"),
    method: input.method,
  };
}

function legalRequired(env: NodeJS.ProcessEnv) {
  return env.NODE_ENV === "production" || env.RELAY_REQUIRE_LEGAL_ACCEPTANCE === "1";
}

export async function userHasCurrentLegalAcceptance(
  userId: string,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
  db?: DbLike,
) {
  const sql = db || await getSql();
  if (env === process.env) env = await effectiveCommercialEnv(env, sql);
  if (!legalRequired(env)) return true;
  const metadata = legalDocumentMetadata(env);
  if (!metadata.configured || !metadata.approved) return false;
  const rows = await sql.query<{ ok: number }>(
    `select 1::int as ok from relay_legal_acceptances
      where user_id=$1 and tenant_id=$2 and terms_version=$3 and privacy_version=$4 and bundle_sha256=$5
      limit 1`,
    [userId, tenantId, metadata.termsVersion, metadata.privacyVersion, metadata.bundleSha256],
  );
  return rows[0]?.ok === 1;
}

export async function tenantHasCurrentLegalAcceptance(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
  db?: DbLike,
) {
  const sql = db || await getSql();
  if (env === process.env) env = await effectiveCommercialEnv(env, sql);
  if (!legalRequired(env)) return true;
  const metadata = legalDocumentMetadata(env);
  if (!metadata.configured || !metadata.approved) return false;
  const rows = await sql.query<{ ok: number }>(
    `select 1::int as ok
       from relay_legal_acceptances a
       join relay_tenant_memberships m on m.tenant_id=a.tenant_id and m.user_id=a.user_id
      where a.tenant_id=$1 and a.terms_version=$2 and a.privacy_version=$3 and a.bundle_sha256=$4
        and m.status='active' and m.role in ('owner','admin')
      limit 1`,
    [tenantId, metadata.termsVersion, metadata.privacyVersion, metadata.bundleSha256],
  );
  return rows[0]?.ok === 1;
}

export async function recordLegalReconsent(
  input: { userId: string; tenantId: string; accepted?: boolean; termsVersion?: string; privacyVersion?: string; bundleSha256?: string },
  request: Request,
  opts: { db?: DbLike; env?: NodeJS.ProcessEnv } = {},
) {
  const sql = opts.db || await getSql();
  const env = opts.env || await effectiveCommercialEnv(process.env, sql);
  const acceptance = prepareLegalAcceptance({
    accepted: input.accepted,
    termsVersion: input.termsVersion,
    privacyVersion: input.privacyVersion,
    bundleSha256: input.bundleSha256,
    method: "reconsent",
  }, request, env);
  if (!acceptance) throw new Error("LEGAL_ACCEPTANCE_NOT_REQUIRED");
  const rows = await sql.query<{ id: string }>(
    `insert into relay_legal_acceptances
      (id,user_id,tenant_id,terms_version,privacy_version,bundle_sha256,ip_hmac,user_agent_hmac,acceptance_method,accepted_at)
     select $1,$2,$3,$4,$5,$6,$7,$8,$9,now()
      where not exists (
        select 1 from relay_legal_acceptances
         where user_id=$2 and tenant_id=$3 and terms_version=$4 and privacy_version=$5 and bundle_sha256=$6
      ) returning id`,
    [acceptance.id, input.userId, input.tenantId, acceptance.termsVersion, acceptance.privacyVersion,
      acceptance.bundleSha256, acceptance.ipHmac, acceptance.userAgentHmac, acceptance.method],
  );
  const id = rows[0]?.id || (await sql.query<{ id: string }>(
    "select id from relay_legal_acceptances where user_id=$1 and tenant_id=$2 and terms_version=$3 and privacy_version=$4 and bundle_sha256=$5 order by accepted_at desc limit 1",
    [input.userId, input.tenantId, acceptance.termsVersion, acceptance.privacyVersion, acceptance.bundleSha256],
  ))[0]?.id;
  if (!id) throw new Error("LEGAL_ACCEPTANCE_RECORD_FAILED");
  return { ok: true as const, id, replay: id !== acceptance.id };
}
