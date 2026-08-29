import { getSql, type Sql } from "./db";
import { uid } from "./utils";

type DbLike = Pick<Sql, "query">;

export type CommercialEvidenceRequirement =
  | "provider_rights"
  | "price_review"
  | "legal_documents"
  | "tax_review"
  | "payment_acceptance"
  | "email_delivery"
  | "ha_topology"
  | "offsite_restore"
  | "alert_delivery"
  | "load_test_200"
  | "production_soak_24h"
  | "release_ci";

export type CommercialEvidenceDefinition = {
  requirement: CommercialEvidenceRequirement;
  label: string;
  description: string;
  maxValidityDays: number;
  scope: "global" | "provider" | "price";
};

export const COMMERCIAL_EVIDENCE_CATALOG: readonly CommercialEvidenceDefinition[] = [
  { requirement: "provider_rights", label: "供应商商业授权", description: "每个启用供应商的书面 API/商业使用权。", maxValidityDays: 365, scope: "provider" },
  { requirement: "price_review", label: "价格版本复核", description: "逐个有效价格版本核对供应商成本、币种、加价和亏损边界。", maxValidityDays: 365, scope: "price" },
  { requirement: "legal_documents", label: "法务文件批准", description: "Terms、Privacy、DPA 和销售地域经法务批准。", maxValidityDays: 365, scope: "global" },
  { requirement: "tax_review", label: "税务方案批准", description: "Stripe Tax 配置或适用销售范围的书面免税结论。", maxValidityDays: 365, scope: "global" },
  { requirement: "payment_acceptance", label: "真实支付验收", description: "Live 支付、Webhook、退款和拒付流程验收。", maxValidityDays: 90, scope: "global" },
  { requirement: "email_delivery", label: "邮件投递验收", description: "验证、重置和运营邮件在生产域名完成投递验收。", maxValidityDays: 30, scope: "global" },
  { requirement: "ha_topology", label: "高可用拓扑核验", description: "Gateway、Worker、数据库、Redis 和对象存储的真实副本与故障转移。", maxValidityDays: 30, scope: "global" },
  { requirement: "offsite_restore", label: "异地恢复演练", description: "从不同账号或地域的备份完成隔离恢复。", maxValidityDays: 30, scope: "global" },
  { requirement: "alert_delivery", label: "告警投递验收", description: "生产告警接收端和外部可用性探针真实送达。", maxValidityDays: 7, scope: "global" },
  { requirement: "load_test_200", label: "200 请求并发验收", description: "按批准场景完成 200 请求并发、限流和账务一致性验收。", maxValidityDays: 30, scope: "global" },
  { requirement: "production_soak_24h", label: "24 小时稳定性验收", description: "候选版本完成连续 24 小时生产暗流量稳定性观察。", maxValidityDays: 30, scope: "global" },
  { requirement: "release_ci", label: "权威发布流水线", description: "权威 Git 仓库的测试、安全、构建、SBOM 和发布门禁通过。", maxValidityDays: 30, scope: "global" },
] as const;

const definitions = new Map(COMMERCIAL_EVIDENCE_CATALOG.map((item) => [item.requirement, item]));
const providerSubjects = new Set(["openai", "google", "vertex", "leonardo"]);
const secretLike = /(?:\bsk-[A-Za-z0-9_-]{8,}|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{20,}|\bBearer\s+[A-Za-z0-9._-]{12,}|BEGIN [A-Z ]*PRIVATE KEY|private_key|password\s*[:=])/i;

type EvidenceRow = Record<string, unknown>;

export type CommercialEvidenceExpectation = {
  requirement: CommercialEvidenceRequirement;
  subject: string;
  label: string;
  description: string;
  maxValidityDays: number;
};

export type CommercialEvidenceState = CommercialEvidenceExpectation & {
  valid: boolean;
  reason: "missing" | "passed" | "failed" | "revoked" | "expired" | "not_yet_observed";
  evidence: ReturnType<typeof publicEvidence> | null;
};

function definitionFor(requirement: string) {
  const definition = definitions.get(requirement as CommercialEvidenceRequirement);
  if (!definition) throw new Error("COMMERCIAL_EVIDENCE_REQUIREMENT_INVALID");
  return definition;
}

function publicEvidence(row: EvidenceRow) {
  return {
    id: String(row.id),
    requirement: String(row.requirement) as CommercialEvidenceRequirement,
    subject: String(row.subject),
    version: Number(row.version),
    status: String(row.status),
    source: String(row.source),
    artifactRef: String(row.artifact_ref),
    artifactSha256: String(row.artifact_sha256),
    note: String(row.note || ""),
    recordedBy: String(row.recorded_by),
    reviewedBy: String(row.reviewed_by),
    observedAt: row.observed_at,
    validUntil: row.valid_until,
    recordedAt: row.recorded_at,
  };
}

function normalizeArtifactRef(value: string) {
  const ref = value.trim();
  if (ref.length < 3 || ref.length > 500 || /[\r\n\0]/.test(ref) || secretLike.test(ref)) {
    throw new Error("COMMERCIAL_EVIDENCE_ARTIFACT_REF_INVALID");
  }
  if (/^https?:/i.test(ref)) {
    const parsed = new URL(ref);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("COMMERCIAL_EVIDENCE_ARTIFACT_URL_INVALID");
    }
    return parsed.toString().replace(/\/$/, "");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9:./_-]{2,499}$/.test(ref)) throw new Error("COMMERCIAL_EVIDENCE_ARTIFACT_REF_INVALID");
  return ref;
}

async function normalizeSubject(requirement: CommercialEvidenceRequirement, value: string, db: DbLike) {
  const definition = definitionFor(requirement);
  const subject = value.trim() || "global";
  if (definition.scope === "global") {
    if (subject !== "global") throw new Error("COMMERCIAL_EVIDENCE_SUBJECT_MUST_BE_GLOBAL");
    return subject;
  }
  if (definition.scope === "provider") {
    if (!providerSubjects.has(subject)) throw new Error("COMMERCIAL_EVIDENCE_PROVIDER_INVALID");
    return subject;
  }
  const price = await db.query<{ id: string }>("select id from relay_price_book where id=$1", [subject]);
  if (!price[0]) throw new Error("COMMERCIAL_EVIDENCE_PRICE_NOT_FOUND");
  return subject;
}

export async function expectedCommercialEvidence(env: NodeJS.ProcessEnv, db?: DbLike): Promise<CommercialEvidenceExpectation[]> {
  const sql = db || await getSql();
  const globals = COMMERCIAL_EVIDENCE_CATALOG
    .filter((item) => item.scope === "global" && (item.requirement !== "email_delivery" || env.RELAY_SAAS_REGISTRATION_ENABLED === "1"))
    .map((item) => ({ requirement: item.requirement, subject: "global", label: item.label, description: item.description, maxValidityDays: item.maxValidityDays }));
  const prices = await sql.query<{ id: string; provider: string; model: string; capability: string; version: number }>(
    `select id,provider,model,capability,version from relay_price_book
      where status='active' and effective_from<=now() and (effective_to is null or effective_to>now())
      order by provider,model,capability,version`,
  );
  const providers = [...new Set(prices.map((price) => price.provider))].sort();
  const providerDefinition = definitionFor("provider_rights");
  const priceDefinition = definitionFor("price_review");
  return [
    ...globals,
    ...providers.map((provider) => ({
      requirement: "provider_rights" as const,
      subject: provider,
      label: `${providerDefinition.label} · ${provider}`,
      description: providerDefinition.description,
      maxValidityDays: providerDefinition.maxValidityDays,
    })),
    ...prices.map((price) => ({
      requirement: "price_review" as const,
      subject: price.id,
      label: `${priceDefinition.label} · ${price.provider}/${price.model}/${price.capability} v${price.version}`,
      description: priceDefinition.description,
      maxValidityDays: priceDefinition.maxValidityDays,
    })),
  ];
}

export async function commercialEvidenceStatus(env: NodeJS.ProcessEnv, db?: DbLike): Promise<CommercialEvidenceState[]> {
  const sql = db || await getSql();
  const expected = await expectedCommercialEvidence(env, sql);
  const rows = await sql.query<EvidenceRow>(
    `select e.* from relay_commercial_launch_evidence e
      join (
        select requirement,subject,max(version)::int as version
          from relay_commercial_launch_evidence group by requirement,subject
      ) latest using(requirement,subject,version)`,
  );
  const byKey = new Map(rows.map((row) => [`${row.requirement}\0${row.subject}`, row]));
  const now = Date.now();
  return expected.map((item) => {
    const row = byKey.get(`${item.requirement}\0${item.subject}`);
    if (!row) return { ...item, valid: false, reason: "missing" as const, evidence: null };
    const status = String(row.status);
    const observed = new Date(String(row.observed_at)).getTime();
    const expires = new Date(String(row.valid_until)).getTime();
    const reason = status === "failed" ? "failed" : status === "revoked" ? "revoked" : observed > now + 5 * 60_000 ? "not_yet_observed" : expires <= now ? "expired" : "passed";
    return { ...item, valid: reason === "passed", reason, evidence: publicEvidence(row) };
  });
}

export async function listCommercialEvidence(db?: DbLike) {
  const sql = db || await getSql();
  const rows = await sql.query<EvidenceRow>("select * from relay_commercial_launch_evidence order by recorded_at desc,version desc limit 200");
  return rows.map(publicEvidence);
}

export async function recordCommercialEvidence(input: {
  requirement: CommercialEvidenceRequirement;
  subject?: string;
  status: "passed" | "failed" | "revoked";
  artifactRef: string;
  artifactSha256: string;
  note: string;
  reviewer: string;
  observedAt: string;
  validUntil: string;
  confirmation: string;
  actor: string;
}, db?: DbLike) {
  if (input.confirmation !== "EVIDENCE_REVIEWED") throw new Error("COMMERCIAL_EVIDENCE_CONFIRMATION_REQUIRED");
  const definition = definitionFor(input.requirement);
  const sql = db || await getSql();
  const subject = await normalizeSubject(input.requirement, input.subject || "global", sql);
  if (!(["passed", "failed", "revoked"] as const).includes(input.status)) throw new Error("COMMERCIAL_EVIDENCE_STATUS_INVALID");
  const artifactRef = normalizeArtifactRef(input.artifactRef);
  const artifactSha256 = input.artifactSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(artifactSha256)) throw new Error("COMMERCIAL_EVIDENCE_SHA256_REQUIRED");
  const actor = input.actor.trim().slice(0, 120);
  const reviewer = input.reviewer.trim().slice(0, 160);
  if (reviewer.length < 3 || reviewer.toLowerCase() === actor.toLowerCase()) throw new Error("COMMERCIAL_EVIDENCE_INDEPENDENT_REVIEWER_REQUIRED");
  const note = input.note.trim();
  if (note.length < 5 || note.length > 500 || secretLike.test(note)) throw new Error("COMMERCIAL_EVIDENCE_NOTE_INVALID");
  const observedAt = new Date(input.observedAt);
  const validUntil = new Date(input.validUntil);
  const now = Date.now();
  if (!Number.isFinite(observedAt.getTime()) || observedAt.getTime() > now + 5 * 60_000) throw new Error("COMMERCIAL_EVIDENCE_OBSERVED_AT_INVALID");
  if (!Number.isFinite(validUntil.getTime()) || validUntil.getTime() <= Math.max(now, observedAt.getTime())) throw new Error("COMMERCIAL_EVIDENCE_VALID_UNTIL_INVALID");
  if (validUntil.getTime() - observedAt.getTime() > definition.maxValidityDays * 86_400_000 + 5 * 60_000) {
    throw new Error("COMMERCIAL_EVIDENCE_VALIDITY_TOO_LONG");
  }
  const id = uid();
  const rows = await sql.query<EvidenceRow>(
    `with next as (
       select coalesce(max(version),0)+1 as version from relay_commercial_launch_evidence where requirement=$1 and subject=$2
     ) insert into relay_commercial_launch_evidence
       (id,requirement,subject,version,status,source,artifact_ref,artifact_sha256,note,recorded_by,reviewed_by,observed_at,valid_until,recorded_at,detail)
       select $3,$1,$2,version,$4,'manual',$5,$6,$7,$8,$9,$10,$11,now(),$12::jsonb from next returning *`,
    [input.requirement, subject, id, input.status, artifactRef, artifactSha256, note, actor, reviewer,
      observedAt.toISOString(), validUntil.toISOString(), JSON.stringify({ maxValidityDays: definition.maxValidityDays, contentStored: false })],
  );
  if (!rows[0]) throw new Error("COMMERCIAL_EVIDENCE_CREATE_FAILED");
  await sql.query(
    `insert into relay_commercial_audit(id,actor_type,actor_id,action,target_type,target_id,detail)
     values ($1,'admin',$2,'launch_evidence.record','commercial_launch_evidence',$3,$4::jsonb)`,
    [uid(), actor, id, JSON.stringify({ requirement: input.requirement, subject, status: input.status, artifactSha256, version: rows[0].version })],
  );
  return publicEvidence(rows[0]);
}
