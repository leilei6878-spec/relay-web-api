import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { audit } from "./audit";
import { patchAccount, readControlPlane } from "./control-plane";
import { getSql } from "./db";
import { enqueueChat, enqueueImage } from "./job-queue";
import { activeSelectorPack } from "./selector-promotion";
import { uid } from "./utils";
import { getAdapter } from "./provider/index";
import { canaryModelFor } from "./provider/canary-run";

export type InspectionCommand =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; deltaY: number }
  | { type: "reload" }
  | { type: "back" }
  | { type: "forward" }
  | { type: "close" };

type InspectionRow = {
  id: string;
  accountId: string;
  mode: "view" | "maintenance";
  status: string;
  proxyId: string | null;
  observedIp: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  finishedAt: string | null;
  closeReason: string | null;
  extra: Record<string, unknown>;
};

const FRAME_DIR = resolve(process.env.RELAY_STORAGE_DIR || "storage", "inspection-frames");

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function sameHash(left: string, right: string) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

function mapInspection(row: Record<string, unknown>): InspectionRow {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    mode: row.mode as InspectionRow["mode"],
    status: String(row.status),
    proxyId: row.proxy_id ? String(row.proxy_id) : null,
    observedIp: row.observed_ip ? String(row.observed_ip) : null,
    createdAt: iso(row.created_at),
    lastSeenAt: iso(row.last_seen_at) || null,
    expiresAt: iso(row.expires_at),
    finishedAt: iso(row.finished_at) || null,
    closeReason: row.close_reason ? String(row.close_reason) : null,
    extra: (row.extra || {}) as Record<string, unknown>,
  };
}

export function secureInspectionRequest(
  request: Request,
  env: { NODE_ENV?: string } = process.env,
) {
  const url = new URL(request.url);
  const forwarded = (request.headers.get("x-forwarded-proto") || "").split(",")[0]?.trim().toLowerCase();
  if (url.protocol === "https:" || forwarded === "https") return true;
  if (env.NODE_ENV !== "production" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)) return true;
  return false;
}

async function inspectionRecord(id: string) {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from relay_account_inspections where id=$1", [id]);
  return rows[0] ? mapInspection(rows[0]) : null;
}

async function authorizedInspection(id: string, token: string) {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from relay_account_inspections where id=$1", [id]);
  if (!rows[0] || !sameHash(String(rows[0].token_hash || ""), tokenHash(token))) return null;
  return mapInspection(rows[0]);
}

export async function createAccountInspection(input: {
  accountId: string;
  mode?: "view" | "maintenance";
  secure: boolean;
  requestedBy?: string;
}) {
  if (!input.secure) {
    return { ok: false as const, status: 409, error: "安全登录态查看要求 HTTPS；当前连接不是安全连接" };
  }
  const plane = await readControlPlane();
  const account = plane.accounts.find((item) => item.id === input.accountId);
  if (!account) return { ok: false as const, status: 404, error: "账号不存在" };
  if (!account.sessionPath) return { ok: false as const, status: 409, error: "账号没有可用登录态" };
  if (!account.proxyId) return { ok: false as const, status: 409, error: "账号没有绑定代理" };
  if (account.lockedUntil && Date.parse(account.lockedUntil) > Date.now()) {
    return { ok: false as const, status: 409, error: "账号正在执行任务，请稍后再打开" };
  }
  const id = uid();
  const token = randomBytes(32).toString("base64url");
  const mode = input.mode === "maintenance" ? "maintenance" : "view";
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const db = await getSql();
  await db.query(
    `insert into relay_account_inspections
      (id,account_id,mode,status,token_hash,requested_by,proxy_id,expected_ip,session_base_version,created_at,expires_at,extra)
     values ($1,$2,$3,'queued',$4,$5,$6,$7,$8,now(),$9,$10::jsonb)`,
    [id, account.id, mode, tokenHash(token), input.requestedBy || "admin", account.proxyId, account.loginIp || null, account.sessionVersion || 0, expiresAt, JSON.stringify({ commandSeq: 0, frameSeq: 0 })],
  );
  const adapter = getAdapter(account.platform);
  const model = canaryModelFor(account.platform, account, adapter.capabilities().models);
  const excludeAccountIds = plane.accounts.filter((item) => item.id !== account.id).map((item) => item.id);
  const options = {
    kind: "inspection" as const,
    inspectionId: id,
    selectorPackVersion: await activeSelectorPack(account.platform),
    excludeAccountIds,
    idempotencyKey: `inspection:${id}`,
    targetAccountId: account.id,
    allowUnhealthyTarget: true,
    n: 1,
    size: "1024x1024",
    aspect: "1:1",
    tier: "Small",
  };
  const queued = account.platform === "chatgpt"
    ? await enqueueChat("Secure account inspection", model, 30 * 60_000, [], options)
    : await enqueueImage("Secure account inspection", model, 30 * 60_000, [], options);
  if (!queued.ok) {
    await db.query("update relay_account_inspections set status='failed', finished_at=now(), close_reason=$2 where id=$1", [id, queued.error]);
    return { ok: false as const, status: 409, error: queued.error };
  }
  await db.query(
    `update relay_account_inspections
        set extra=jsonb_set(coalesce(extra,'{}'::jsonb),'{jobId}',to_jsonb($2::text),true)
      where id=$1`,
    [id, queued.job.id],
  );
  await patchAccount(account.id, { inspectionId: id });
  await audit("account.inspection.create", JSON.stringify({ inspectionId: id, accountId: account.id, mode }));
  return { ok: true as const, inspectionId: id, token, expiresAt, mode };
}

export async function getAccountInspection(id: string, token: string) {
  const row = await authorizedInspection(safeId(id), token);
  if (!row) return null;
  return {
    ...row,
    frameSeq: Number(row.extra.frameSeq || 0),
    commandSeq: Number(row.extra.commandSeq || 0),
    pageUrl: String(row.extra.pageUrl || ""),
    pageTitle: String(row.extra.pageTitle || ""),
    viewportWidth: Number(row.extra.viewportWidth || 1365),
    viewportHeight: Number(row.extra.viewportHeight || 900),
  };
}

export async function commandAccountInspection(id: string, token: string, command: InspectionCommand) {
  const row = await authorizedInspection(safeId(id), token);
  if (!row) return { ok: false as const, status: 404, error: "查看会话不存在或令牌无效" };
  if (!["queued", "active", "closing"].includes(row.status)) return { ok: false as const, status: 409, error: "查看会话已经结束" };
  if (row.mode === "view" && !["scroll", "reload", "back", "forward", "close"].includes(command.type)) {
    return { ok: false as const, status: 403, error: "查看模式不允许修改页面；请使用维护模式" };
  }
  const extra = { ...row.extra, commandSeq: Number(row.extra.commandSeq || 0) + 1, command };
  const db = await getSql();
  await db.query(
    `update relay_account_inspections
        set status=case when $3='close' then 'closing' else status end, last_seen_at=now(), extra=$2::jsonb
      where id=$1`,
    [row.id, JSON.stringify(extra), command.type],
  );
  return { ok: true as const, commandSeq: extra.commandSeq };
}

export async function workerInspectionPoll(id: string, afterSeq: number) {
  const row = await inspectionRecord(safeId(id));
  if (!row) return { ok: false as const, close: true, error: "inspection missing" };
  if (Date.parse(row.expiresAt) <= Date.now() || !["queued", "active", "closing"].includes(row.status)) {
    return { ok: true as const, close: true, commandSeq: Number(row.extra.commandSeq || 0) };
  }
  const commandSeq = Number(row.extra.commandSeq || 0);
  return {
    ok: true as const,
    close: row.status === "closing",
    mode: row.mode,
    commandSeq,
    command: commandSeq > afterSeq ? row.extra.command || null : null,
  };
}

export async function workerInspectionStatus(id: string, patch: Record<string, unknown>) {
  const row = await inspectionRecord(safeId(id));
  if (!row) return { ok: false as const, status: 404, error: "inspection missing" };
  const allowed = {
    pageUrl: typeof patch.pageUrl === "string" ? patch.pageUrl.slice(0, 2000) : row.extra.pageUrl,
    pageTitle: typeof patch.pageTitle === "string" ? patch.pageTitle.slice(0, 500) : row.extra.pageTitle,
    viewportWidth: Number(patch.viewportWidth || row.extra.viewportWidth || 1365),
    viewportHeight: Number(patch.viewportHeight || row.extra.viewportHeight || 900),
    frameSeq: Number(patch.frameSeq || row.extra.frameSeq || 0),
    commandSeq: Number(row.extra.commandSeq || 0),
    command: row.extra.command || null,
    jobId: row.extra.jobId || null,
  };
  const status = ["active", "closed", "failed"].includes(String(patch.status)) ? String(patch.status) : row.status;
  const db = await getSql();
  await db.query(
    `update relay_account_inspections
        set status=$2, observed_ip=coalesce($3,observed_ip), last_seen_at=now(),
            finished_at=case when $2 in ('closed','failed') then now() else finished_at end,
            close_reason=coalesce($4,close_reason), extra=$5::jsonb
      where id=$1`,
    [row.id, status, patch.observedIp || null, patch.closeReason || null, JSON.stringify(allowed)],
  );
  if (status === "closed" || status === "failed") {
    await patchAccount(row.accountId, { inspectionId: null });
    await deleteInspectionFrame(row.id);
  }
  return { ok: true as const };
}

export async function saveInspectionFrame(id: string, bytes: Buffer) {
  const clean = safeId(id);
  if (!clean || bytes.length < 100 || bytes.length > 2_000_000) return { ok: false as const, status: 400, error: "invalid frame" };
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8) && !(bytes[0] === 0x89 && bytes[1] === 0x50)) {
    return { ok: false as const, status: 400, error: "frame must be JPEG or PNG" };
  }
  const row = await inspectionRecord(clean);
  if (!row || !["queued", "active", "closing"].includes(row.status)) return { ok: false as const, status: 404, error: "inspection inactive" };
  await mkdir(FRAME_DIR, { recursive: true });
  const file = resolve(FRAME_DIR, `${clean}.jpg`);
  const temporary = `${file}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, file);
  const frameSeq = Number(row.extra.frameSeq || 0) + 1;
  await workerInspectionStatus(clean, { status: "active", frameSeq });
  return { ok: true as const, frameSeq };
}

export async function readInspectionFrame(id: string, token: string) {
  const row = await authorizedInspection(safeId(id), token);
  if (!row) return null;
  try {
    return await readFile(resolve(FRAME_DIR, `${row.id}.jpg`));
  } catch {
    return null;
  }
}

async function deleteInspectionFrame(id: string) {
  await unlink(resolve(FRAME_DIR, `${safeId(id)}.jpg`)).catch(() => undefined);
}

export async function listAccountInspections(accountId?: string) {
  const db = await getSql();
  const rows = accountId
    ? await db.query<Record<string, unknown>>("select * from relay_account_inspections where account_id=$1 order by created_at desc limit 30", [accountId])
    : await db.query<Record<string, unknown>>("select * from relay_account_inspections order by created_at desc limit 30");
  return rows.map(mapInspection).map((row) => ({ ...row, extra: undefined }));
}
