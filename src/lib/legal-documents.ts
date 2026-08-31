import { createHash, createHmac } from "node:crypto";
import { trustedClientIp } from "./client-network";
import { LEGAL_CONTENT_REVISION, LEGAL_PRIVACY_SECTIONS, LEGAL_TERMS_SECTIONS, type LegalPublicMetadata } from "./legal-content";
import { uid } from "./utils";

export type LegalDocumentMetadata = LegalPublicMetadata;

export type PreparedLegalAcceptance = {
  id: string;
  termsVersion: string;
  privacyVersion: string;
  bundleSha256: string;
  ipHmac: string;
  userAgentHmac: string;
  method: "registration" | "invite";
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
  input: { accepted?: boolean; termsVersion?: string; privacyVersion?: string; bundleSha256?: string; method: "registration" | "invite" },
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
