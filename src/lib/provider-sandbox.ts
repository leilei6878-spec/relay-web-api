import { effectiveCommercialEnv } from "./commercial-config";
import type { CommercialCapability, PriceBookRow } from "./commercial-types";
import { getSql, type Sql } from "./db";
import { officialChat, officialImage, resolveOfficialModel, type OfficialChatResult, type OfficialImageResult, type OfficialProvider } from "./official-providers";
import { calculateChargeMinor } from "./saas-billing";
import { uid } from "./utils";

type DbLike = Pick<Sql, "query">;
type ChatFn = typeof officialChat;
type ImageFn = typeof officialImage;

function dbOrDefault(db?: DbLike) {
  return db || getSql();
}

function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value || "");
}

function mapPrice(row: Record<string, unknown>): PriceBookRow {
  return {
    id: String(row.id), version: Number(row.version), provider: String(row.provider), model: String(row.model),
    capability: row.capability as CommercialCapability, currency: String(row.currency),
    inputMicrosPerMillion: Number(row.input_micros_per_million || 0), outputMicrosPerMillion: Number(row.output_micros_per_million || 0),
    imagePriceMinor: Number(row.image_price_minor || 0), markupBasisPoints: Number(row.markup_basis_points || 0),
    effectiveFrom: iso(row.effective_from), effectiveTo: row.effective_to ? iso(row.effective_to) : null,
    status: row.status as PriceBookRow["status"],
  };
}

function sanitizeError(value: string) {
  return value
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:sk|rk|whsec|AIza)[-_A-Za-z0-9]{8,}\b/g, "[secret]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/Bearer\s+\S+/gi, "Bearer [secret]")
    .slice(0, 400);
}

function publicRun(row: Record<string, unknown>) {
  return {
    id: String(row.id), provider: String(row.provider), model: String(row.model), capability: String(row.capability),
    mode: String(row.mode), status: String(row.status), currency: String(row.currency),
    estimatedChargeMinor: Number(row.estimated_charge_minor || 0), promptTokens: Number(row.prompt_tokens || 0),
    completionTokens: Number(row.completion_tokens || 0), images: Number(row.images || 0),
    upstreamReference: row.upstream_reference || null, errorCode: row.error_code || null, errorMessage: row.error_message || null,
    initiatedBy: String(row.initiated_by), startedAt: row.started_at, finishedAt: row.finished_at || null,
    detail: row.detail || {},
  };
}

export async function listProviderSandboxRuns(db?: DbLike) {
  const rows = await (await dbOrDefault(db)).query<Record<string, unknown>>(
    "select * from relay_provider_sandbox_runs order by started_at desc limit 200",
  );
  return rows.map(publicRun);
}

export async function runProviderSandbox(
  input: { provider: OfficialProvider; model: string; capability: CommercialCapability; currency?: string; confirmation: string; actor: string },
  opts: { db?: DbLike; env?: NodeJS.ProcessEnv; chat?: ChatFn; image?: ImageFn } = {},
) {
  const sql = await dbOrDefault(opts.db);
  const env = opts.env || await effectiveCommercialEnv(process.env, sql);
  if (env.RELAY_ALLOW_LIVE_PROVIDER_CANARY !== "1") throw new Error("LIVE_PROVIDER_CANARY_HARD_GATE_CLOSED");
  if (input.confirmation !== "LIVE_COST_ACCEPTED") throw new Error("LIVE_PROVIDER_CANARY_CONFIRMATION_REQUIRED");
  if (!["openai", "google", "vertex", "leonardo"].includes(input.provider)) throw new Error("CANARY_PROVIDER_INVALID");
  const resolved = resolveOfficialModel(`${input.provider}:${input.model}`);
  if (resolved.provider !== input.provider) throw new Error("CANARY_PROVIDER_MODEL_MISMATCH");
  if (input.provider === "leonardo" && input.capability === "chat") throw new Error("CANARY_CAPABILITY_UNSUPPORTED");
  const currency = (input.currency || "USD").toUpperCase();
  const prices = await sql.query<Record<string, unknown>>(
    `select * from relay_price_book where provider=$1 and model=$2 and capability=$3 and currency=$4
      and status='active' and effective_from<=now() and (effective_to is null or effective_to>now())
      order by version desc limit 1`,
    [input.provider, input.model, input.capability, currency],
  );
  if (!prices[0]) throw new Error("CANARY_ACTIVE_PRICE_REQUIRED");
  const price = mapPrice(prices[0]);
  const estimatedChargeMinor = calculateChargeMinor(price, input.capability === "chat"
    ? { promptTokens: 64, completionTokens: 32 }
    : { images: 1 });
  const maximum = Math.max(1, Math.min(10_000, Number(env.RELAY_CANARY_MAX_CHARGE_MINOR || 100)));
  if (estimatedChargeMinor <= 0 || estimatedChargeMinor > maximum) throw new Error("CANARY_ESTIMATED_CHARGE_EXCEEDS_LIMIT");
  const id = uid();
  const created = await sql.query<Record<string, unknown>>(
    `insert into relay_provider_sandbox_runs
      (id,provider,model,capability,mode,status,currency,estimated_charge_minor,initiated_by,started_at,detail)
     values ($1,$2,$3,$4,'live','running',$5,$6,$7,now(),'{"contentStored":false,"fixedPrompt":true}'::jsonb)
     returning *`,
    [id, input.provider, input.model, input.capability, currency, estimatedChargeMinor, input.actor.slice(0, 120)],
  );
  if (!created[0]) throw new Error("CANARY_RUN_CREATE_FAILED");
  let result: OfficialChatResult | OfficialImageResult;
  try {
    result = input.capability === "chat"
      ? await (opts.chat || officialChat)(
          { resolved, messages: [{ role: "user", content: "Reply with exactly RELAY_CANARY_OK" }], maxCompletionTokens: 32, temperature: 0, tenantId: "relay-provider-canary" },
          { env, db: sql },
        )
      : await (opts.image || officialImage)(
          { resolved, prompt: "A plain neutral gray square, no text, provider availability canary", n: 1, size: "1024x1024", tenantId: "relay-provider-canary" },
          { env, db: sql },
        );
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
    if (input.capability === "chat" && (!("text" in result) || !result.text.includes("RELAY_CANARY_OK"))) {
      throw Object.assign(new Error("Provider canary text mismatch"), { code: "CANARY_TEXT_MISMATCH" });
    }
    const passed = await sql.query<Record<string, unknown>>(
      `update relay_provider_sandbox_runs set status='passed',prompt_tokens=$2,completion_tokens=$3,images=$4,
         upstream_reference=$5,finished_at=now(),error_code=null,error_message=null
        where id=$1 and status='running' returning *`,
      [id, result.promptTokens, result.completionTokens, "images" in result ? result.images.length : 0, result.id.slice(0, 200)],
    );
    await sql.query(
      `insert into relay_commercial_audit(id,actor_type,actor_id,action,target_type,target_id,detail)
       values ($1,'admin',$2,'provider.canary.passed','provider_sandbox',$3,$4::jsonb)`,
      [uid(), input.actor.slice(0, 120), id, JSON.stringify({ provider: input.provider, model: input.model, capability: input.capability, estimatedChargeMinor })],
    );
    return publicRun(passed[0]!);
  } catch (error) {
    const code = String(error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code || "CANARY_FAILED" : "CANARY_FAILED").slice(0, 120);
    const message = sanitizeError(error instanceof Error ? error.message : "Provider canary failed");
    const failed = await sql.query<Record<string, unknown>>(
      `update relay_provider_sandbox_runs set status='failed',error_code=$2,error_message=$3,finished_at=now()
        where id=$1 and status='running' returning *`,
      [id, code, message],
    );
    await sql.query(
      `insert into relay_commercial_audit(id,actor_type,actor_id,action,target_type,target_id,detail)
       values ($1,'admin',$2,'provider.canary.failed','provider_sandbox',$3,$4::jsonb)`,
      [uid(), input.actor.slice(0, 120), id, JSON.stringify({ provider: input.provider, model: input.model, capability: input.capability, code })],
    );
    return publicRun(failed[0]!);
  }
}
