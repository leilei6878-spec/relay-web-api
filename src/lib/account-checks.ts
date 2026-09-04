import { audit } from "./audit";
import { boundProxySecret, patchAccount, readControlPlane } from "./control-plane";
import { getSql } from "./db";
import { probeProxyJob } from "./chatgpt-runner";
import { enqueueChat, enqueueImage, waitJob } from "./job-queue";
import { activeSelectorPack } from "./selector-promotion";
import { probeSessionFile } from "./session-probe";
import { uid } from "./utils";
import { getAdapter } from "./provider/index";
import { canaryModelFor } from "./provider/canary-run";
import type { Account, AccountCheckLevel, AccountCheckRecord, AccountCheckRun, AccountIpState, Platform } from "./types";

type CheckTrigger = "manual" | "scheduled";
type CheckScope = {
  ids?: string[];
  platform?: Platform | "all";
  status?: string | "all";
  batch?: string;
  q?: string;
  proxyId?: string;
  ipState?: string;
  expiry?: "all" | "expired" | "24h" | "7d" | "none";
};

export type CheckResult = {
  ok: boolean;
  code: string;
  detail: string;
  expectedIp?: string | null;
  observedIp?: string | null;
  ipState?: AccountIpState;
  pageState?: string | null;
  latencyMs?: number;
  sessionExpiresAt?: string | null;
};

let activeCheckSlots = 0;
const checkWaiters: (() => void)[] = [];
let proxyCheckChain: Promise<unknown> = Promise.resolve();

async function withCheckSlot<T>(task: () => Promise<T>) {
  const limit = Math.max(1, Math.min(4, Number(process.env.RELAY_ACCOUNT_CHECK_CONCURRENCY || 2)));
  if (activeCheckSlots >= limit) await new Promise<void>((resolve) => checkWaiters.push(resolve));
  activeCheckSlots += 1;
  try {
    return await task();
  } finally {
    activeCheckSlots -= 1;
    checkWaiters.shift()?.();
  }
}

function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function rowRun(row: Record<string, unknown>): AccountCheckRun {
  return {
    id: String(row.id),
    trigger: row.trigger as AccountCheckRun["trigger"],
    requestedBy: String(row.requested_by || "admin"),
    scope: (row.scope || {}) as Record<string, unknown>,
    levels: (row.levels || []) as AccountCheckLevel[],
    status: row.status as AccountCheckRun["status"],
    total: Number(row.total || 0),
    completed: Number(row.completed || 0),
    passed: Number(row.passed || 0),
    failed: Number(row.failed || 0),
    cancelled: Number(row.cancelled || 0),
    createdAt: iso(row.created_at) || "",
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

function rowCheck(row: Record<string, unknown>): AccountCheckRecord {
  return {
    id: String(row.id),
    runId: row.run_id ? String(row.run_id) : null,
    accountId: String(row.account_id),
    platform: row.platform as Platform,
    trigger: row.trigger as AccountCheckRecord["trigger"],
    level: row.level as AccountCheckLevel,
    status: row.status as AccountCheckRecord["status"],
    resultCode: row.result_code ? String(row.result_code) : null,
    detail: row.detail ? String(row.detail) : null,
    expectedIp: row.expected_ip ? String(row.expected_ip) : null,
    observedIp: row.observed_ip ? String(row.observed_ip) : null,
    ipState: (row.ip_state || null) as AccountCheckRecord["ipState"],
    pageState: row.page_state ? String(row.page_state) : null,
    latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
    workerId: row.worker_id ? String(row.worker_id) : null,
    startedAt: iso(row.started_at) || "",
    finishedAt: iso(row.finished_at),
  };
}

function selectedAccounts(accounts: Account[], scope: CheckScope) {
  const ids = new Set((scope.ids || []).map(String));
  const needle = (scope.q || "").trim().toLowerCase();
  return accounts.filter((account) => {
    if (ids.size && !ids.has(account.id)) return false;
    if (scope.platform && scope.platform !== "all" && account.platform !== scope.platform) return false;
    if (scope.status && scope.status !== "all" && account.status !== scope.status) return false;
    if (scope.batch && account.batch !== scope.batch) return false;
    if (scope.proxyId && account.proxyId !== scope.proxyId) return false;
    if (scope.ipState && scope.ipState !== "all" && (account.ipState || "unknown") !== scope.ipState) return false;
    if (scope.expiry && scope.expiry !== "all") {
      const expires = Date.parse(account.expiresAt || "");
      const now = Date.now();
      if (scope.expiry === "none" && Number.isFinite(expires)) return false;
      if (scope.expiry === "expired" && (!Number.isFinite(expires) || expires > now)) return false;
      if (scope.expiry === "24h" && (!Number.isFinite(expires) || expires <= now || expires > now + 86_400_000)) return false;
      if (scope.expiry === "7d" && (!Number.isFinite(expires) || expires <= now || expires > now + 7 * 86_400_000)) return false;
    }
    if (needle) {
      const text = [account.email, account.remark, account.batch, ...(account.tags || []), account.loginIp, account.lastProbeIp]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (!text.includes(needle)) return false;
    }
    return true;
  });
}

export function normalizeCheckLevels(levels: unknown): AccountCheckLevel[] {
  const source = Array.isArray(levels) ? levels : ["static", "proxy", "live"];
  const allowed = new Set<AccountCheckLevel>(["static", "proxy", "live"]);
  return [...new Set(source.map(String).filter((level): level is AccountCheckLevel => allowed.has(level as AccountCheckLevel)))];
}

export async function createAccountCheckRun(input: {
  trigger?: CheckTrigger;
  requestedBy?: string;
  scope?: CheckScope;
  levels?: unknown;
}) {
  const plane = await readControlPlane();
  const scope = input.scope || {};
  const accounts = selectedAccounts(plane.accounts, scope).slice(0, 500);
  const levels = normalizeCheckLevels(input.levels);
  if (!accounts.length) return { ok: false as const, status: 400, error: "检查范围内没有账号" };
  if (!levels.length) return { ok: false as const, status: 400, error: "至少选择一种检查方式" };
  const id = uid();
  const trigger = input.trigger || "manual";
  const db = await getSql();
  await db.query(
    `insert into relay_account_check_runs
      (id, trigger, requested_by, scope, levels, status, total, created_at)
     values ($1,$2,$3,$4::jsonb,$5,'queued',$6,now())`,
    [id, trigger, input.requestedBy || "admin", JSON.stringify({ ...scope, resolvedIds: accounts.map((account) => account.id) }), levels, accounts.length],
  );
  await audit("account.check-run.create", JSON.stringify({ runId: id, trigger, total: accounts.length, levels }));
  void executeAccountCheckRun(id).catch(async (error) => {
    await failRun(id, error instanceof Error ? error.message : "检查任务异常");
  });
  return { ok: true as const, runId: id, total: accounts.length, levels };
}

async function failRun(id: string, error: string) {
  const db = await getSql();
  await db.query(
    `update relay_account_check_runs
        set status='done', failed=greatest(failed, total-completed), completed=total,
            finished_at=now(), extra=jsonb_build_object('error',$2)
      where id=$1 and status in ('queued','running')`,
    [id, error.slice(0, 1000)],
  );
}

async function insertCheck(run: AccountCheckRun, account: Account, level: AccountCheckLevel, result: CheckResult, started: number) {
  const db = await getSql();
  await db.query(
    `insert into relay_account_checks
      (id,run_id,account_id,platform,trigger,level,status,result_code,detail,expected_ip,observed_ip,ip_state,page_state,latency_ms,started_at,finished_at,extra)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,to_timestamp($15 / 1000.0),now(),$16::jsonb)`,
    [
      uid(), run.id, account.id, account.platform, run.trigger, level, result.ok ? "passed" : "failed",
      result.code, result.detail.slice(0, 2000), result.expectedIp ?? null, result.observedIp ?? null,
      result.ipState ?? null, result.pageState ?? null, result.latencyMs ?? Date.now() - started, started,
      JSON.stringify({ sessionExpiresAt: result.sessionExpiresAt || null }),
    ],
  );
}

async function staticCheck(account: Account): Promise<CheckResult> {
  const started = Date.now();
  const session = await probeSessionFile(account.id, account.platform);
  if (!session.ok) {
    return { ok: false, code: /过期/.test(session.reason) ? "SESSION_EXPIRED" : "SESSION_INVALID", detail: session.reason, latencyMs: Date.now() - started };
  }
  const sessionExpiresAt = session.expiresAt ? new Date(session.expiresAt * 1000).toISOString() : null;
  return {
    ok: true,
    code: session.warning ? "SESSION_EXPIRING" : "SESSION_OK",
    detail: session.warning || `Session 文件有效，${session.cookieCount} 枚 Cookie`,
    latencyMs: Date.now() - started,
    sessionExpiresAt,
  };
}

async function proxyCheck(account: Account): Promise<CheckResult> {
  const started = Date.now();
  const plane = await readControlPlane();
  const proxy = plane.proxies.find((item) => item.id === account.proxyId);
  if (!proxy || proxy.status !== "active") {
    return { ok: false, code: "PROXY_UNAVAILABLE", detail: proxy ? "绑定代理已停用" : "账号未绑定代理", ipState: "proxy_unavailable", latencyMs: Date.now() - started };
  }
  const password = await boundProxySecret(proxy.id);
  const checked = await probeProxyJob({
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password,
    localPort: proxy.localPort,
    method: proxy.method,
  });
  const observed = checked.ip || null;
  if (!checked.ok || !checked.tunnelOk || !observed) {
    return {
      ok: false,
      code: "PROXY_UNAVAILABLE",
      detail: checked.error || "代理没有取得真实出口 IP",
      expectedIp: account.loginIp || proxy.lastCheckIp || null,
      observedIp: observed,
      ipState: "proxy_unavailable",
      latencyMs: checked.ms || Date.now() - started,
    };
  }
  const expected = account.loginIp || proxy.lastCheckIp || observed;
  const drift = Boolean(expected && expected !== observed);
  return {
    ok: !drift,
    code: drift ? "IP_DRIFT" : "PROXY_OK",
    detail: drift ? `出口 IP 从 ${expected} 变为 ${observed}` : `代理出口 ${observed}`,
    expectedIp: expected,
    observedIp: observed,
    ipState: drift ? "drift" : "matched",
    latencyMs: checked.ms || Date.now() - started,
  };
}

function serializedProxyCheck(account: Account) {
  const run = proxyCheckChain.then(() => proxyCheck(account), () => proxyCheck(account));
  proxyCheckChain = run.then(() => undefined, () => undefined);
  return run;
}

async function liveCheck(account: Account, runId: string): Promise<CheckResult> {
  const started = Date.now();
  const plane = await readControlPlane();
  const current = plane.accounts.find((item) => item.id === account.id);
  if (!current) return { ok: false, code: "ACCOUNT_MISSING", detail: "账号已不存在" };
  if (!current.sessionPath) return { ok: false, code: "SESSION_INVALID", detail: "没有 Session" };
  if (current.ipState === "drift" || current.ipState === "proxy_unavailable") {
    return { ok: false, code: current.ipState === "drift" ? "IP_DRIFT" : "PROXY_UNAVAILABLE", detail: "IP/代理检查未通过，未打开平台网页", ipState: current.ipState };
  }
  const adapter = getAdapter(current.platform);
  const model = canaryModelFor(current.platform, current, adapter.capabilities().models);
  const options = {
    kind: "canary" as const,
    accountCheck: true,
    targetAccountId: current.id,
    allowUnhealthyTarget: true,
    selectorPackVersion: await activeSelectorPack(current.platform),
    idempotencyKey: `account-check:${runId}:${current.id}`,
    n: 1,
    size: "1024x1024",
    aspect: "1:1",
    tier: "Small",
  };
  const queued = current.platform === "chatgpt"
    ? await enqueueChat("Account availability structural check", model, 45_000, [], options)
    : await enqueueImage("Account availability structural check", model, 45_000, [], options);
  if (!queued.ok) return { ok: false, code: "LIVE_CHECK_QUEUE_FAILED", detail: queued.error, latencyMs: Date.now() - started };
  const result = await waitJob(queued.job.id, 45_000, { graceMs: 10_000 });
  const latest = (await readControlPlane()).accounts.find((item) => item.id === account.id);
  if (!result.ok) {
    const error = result.error || "网页检查失败";
    const code = /LOGIN|SESSION/i.test(error)
      ? "LOGIN_REQUIRED"
      : /CHALLENGE|CAPTCHA/i.test(error)
        ? "CHALLENGE"
        : /DOM|SELECTOR/i.test(error)
          ? "DOM_CHANGED"
          : "LIVE_CHECK_FAILED";
    return { ok: false, code, detail: error, pageState: latest?.lastPageState || null, latencyMs: Date.now() - started };
  }
  return {
    ok: true,
    code: "LIVE_OK",
    detail: `真实网页登录态可用（${latest?.lastPageState || "AUTHENTICATED"}）`,
    pageState: latest?.lastPageState || null,
    latencyMs: Date.now() - started,
  };
}

export function healthPatchForResults(account: Account, results: CheckResult[], nowIso = new Date().toISOString()): Partial<Account> {
  const failed = results.find((result) => !result.ok);
  const explicitInvalid = failed && ["SESSION_EXPIRED", "SESSION_INVALID", "LOGIN_REQUIRED", "IP_DRIFT"].includes(failed.code);
  const consecutive = failed ? (account.consecutiveProbeFailures || 0) + 1 : 0;
  const invalid = Boolean(explicitInvalid || (failed && consecutive >= 2));
  const proxy = results.find((result) => result.observedIp || result.ipState);
  const staticResult = results.find((result) => result.code.startsWith("SESSION_"));
  const liveResult = results.find((result) => result.code.startsWith("LIVE_") || result.code === "LOGIN_REQUIRED" || result.code === "CHALLENGE" || result.code === "DOM_CHANGED");
  const patch: Partial<Account> = {
    lastProbeAt: nowIso,
    lastHealthAt: nowIso,
    nextProbeAt: new Date(Date.parse(nowIso) + (failed ? 15 * 60_000 : 2 * 60 * 60_000)).toISOString(),
    consecutiveProbeFailures: consecutive,
    healthScore: failed ? Math.max(0, 100 - consecutive * 30 - (explicitInvalid ? 40 : 0)) : 100,
    lastError: failed ? `${failed.code}: ${failed.detail}` : null,
    status: invalid ? "invalid" : failed ? "probing" : "healthy",
  };
  if (staticResult) {
    patch.lastStaticProbeAt = nowIso;
    patch.sessionExpiresAt = staticResult.sessionExpiresAt || account.sessionExpiresAt || null;
    patch.sessionWarning = staticResult.code === "SESSION_EXPIRING" ? staticResult.detail : null;
  }
  if (proxy) {
    patch.lastProxyProbeAt = nowIso;
    patch.lastProbeIp = proxy.observedIp || null;
    patch.loginIp = account.loginIp || proxy.observedIp || null;
    patch.ipState = proxy.ipState || "unknown";
  }
  if (liveResult) {
    patch.lastLiveProbeAt = nowIso;
    if (liveResult.pageState) patch.lastPageState = liveResult.pageState;
  }
  return patch;
}

async function checkAccount(run: AccountCheckRun, account: Account) {
  const results: CheckResult[] = [];
  for (const level of run.levels) {
    const current = (await readControlPlane()).accounts.find((item) => item.id === account.id) || account;
    const started = Date.now();
    const result = level === "static" ? await staticCheck(current) : level === "proxy" ? await serializedProxyCheck(current) : await liveCheck(current, run.id);
    results.push(result);
    await insertCheck(run, current, level, result, started);
    if (!result.ok && (level !== "static" || result.code !== "SESSION_EXPIRING")) break;
    await patchAccount(current.id, healthPatchForResults(current, results));
  }
  const latest = (await readControlPlane()).accounts.find((item) => item.id === account.id) || account;
  await patchAccount(account.id, healthPatchForResults(latest, results));
  return results.every((result) => result.ok);
}

export async function executeAccountCheckRun(id: string) {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>("select * from relay_account_check_runs where id=$1", [id]);
  if (!rows[0]) return { ok: false as const, error: "检查任务不存在" };
  const run = rowRun(rows[0]);
  if (run.status === "cancelled" || run.status === "done") return { ok: false as const, error: "检查任务已经结束" };
  await db.query("update relay_account_check_runs set status='running', started_at=coalesce(started_at,now()) where id=$1", [id]);
  const scope = run.scope as CheckScope & { resolvedIds?: string[] };
  const plane = await readControlPlane();
  const ids = new Set(scope.resolvedIds || []);
  const accounts = plane.accounts.filter((account) => ids.has(account.id));
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(4, Number(process.env.RELAY_ACCOUNT_CHECK_CONCURRENCY || 2)));
  async function worker() {
    while (cursor < accounts.length) {
      const account = accounts[cursor++];
      if (!account) return;
      const statusRows = await db.query<{ status: string }>("select status from relay_account_check_runs where id=$1", [id]);
      if (statusRows[0]?.status === "cancelled") {
        await db.query("update relay_account_check_runs set cancelled=cancelled+1, completed=completed+1 where id=$1", [id]);
        continue;
      }
      let passed = false;
      try {
        passed = await withCheckSlot(() => checkAccount({ ...run, status: "running" }, account));
      } catch (error) {
        await insertCheck(run, account, run.levels[0] || "static", {
          ok: false,
          code: "CHECK_INTERNAL_ERROR",
          detail: error instanceof Error ? error.message : "检查异常",
        }, Date.now());
      }
      await db.query(
        `update relay_account_check_runs
            set completed=completed+1, passed=passed+$2, failed=failed+$3
          where id=$1`,
        [id, passed ? 1 : 0, passed ? 0 : 1],
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, () => worker()));
  await db.query(
    `update relay_account_check_runs
        set status=case when status='cancelled' then status else 'done' end, finished_at=now()
      where id=$1`,
    [id],
  );
  await audit("account.check-run.finish", JSON.stringify({ runId: id }));
  await import("./account-analytics").then((module) => module.captureAvailabilitySample()).catch(() => undefined);
  return { ok: true as const };
}

export async function cancelAccountCheckRun(id: string) {
  const db = await getSql();
  const rows = await db.query<{ id: string }>(
    "update relay_account_check_runs set status='cancelled', finished_at=now() where id=$1 and status in ('queued','running') returning id",
    [id],
  );
  return rows.length ? { ok: true as const } : { ok: false as const, status: 409, error: "任务不存在或已经结束" };
}

export async function getAccountCheckRun(id: string) {
  const db = await getSql();
  const runs = await db.query<Record<string, unknown>>("select * from relay_account_check_runs where id=$1", [id]);
  if (!runs[0]) return null;
  const checks = await db.query<Record<string, unknown>>(
    "select * from relay_account_checks where run_id=$1 order by started_at asc",
    [id],
  );
  return { run: rowRun(runs[0]), checks: checks.map(rowCheck) };
}

export async function listAccountChecks(accountId?: string, limit = 100) {
  const db = await getSql();
  const checks = accountId
    ? await db.query<Record<string, unknown>>("select * from relay_account_checks where account_id=$1 order by started_at desc limit $2", [accountId, limit])
    : await db.query<Record<string, unknown>>("select * from relay_account_checks order by started_at desc limit $1", [limit]);
  const runs = await db.query<Record<string, unknown>>("select * from relay_account_check_runs order by created_at desc limit 30");
  return { runs: runs.map(rowRun), checks: checks.map(rowCheck) };
}
