import { getSql } from "./db";
import type { Account, GatewaySettings, Proxy } from "./types";
import type { ApiKeyRecord } from "./api-keys";

export type PlaneRow = {
  accounts: Account[];
  proxies: Proxy[];
  settings: GatewaySettings;
  savedAt: string;
};

async function sql() {
  if (process.env.RELAY_SKIP_DB === "1") throw new Error("RELAY_SKIP_DB");
  return getSql();
}

function json(v: unknown) {
  return JSON.stringify(v ?? null);
}

export async function dbSyncPlane(plane: PlaneRow) {
  const db = await sql();
  await db.query("delete from relay_accounts");
  await db.query("delete from relay_proxies");
  for (const a of plane.accounts) {
    await db.query(
      `insert into relay_accounts
        (id, platform, email, remark, status, proxy_id, session_path, session_version, fail_count, total_requests,
         last_used_at, locked_until, last_error, last_probe_at, session_warning, created_at, extra)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
       on conflict (id) do update set
         platform=excluded.platform, email=excluded.email, remark=excluded.remark, status=excluded.status,
         proxy_id=excluded.proxy_id, session_path=excluded.session_path, session_version=excluded.session_version,
         fail_count=excluded.fail_count, total_requests=excluded.total_requests, last_used_at=excluded.last_used_at,
         locked_until=excluded.locked_until, last_error=excluded.last_error, last_probe_at=excluded.last_probe_at,
         session_warning=excluded.session_warning, extra=excluded.extra`,
      [
        a.id,
        a.platform,
        a.email,
        a.remark,
        a.status,
        a.proxyId,
        a.sessionPath,
        a.sessionVersion || 0,
        a.failCount || 0,
        a.totalRequests || 0,
        a.lastUsedAt,
        a.lockedUntil ?? null,
        a.lastError ?? null,
        a.lastProbeAt ?? null,
        a.sessionWarning ?? null,
        a.createdAt,
        json(a),
      ],
    );
  }
  for (const p of plane.proxies) {
    await db.query(
      `insert into relay_proxies
        (id, name, type, host, port, username, sticky_session_id, region, status, max_accounts, remark, created_at, extra)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       on conflict (id) do update set
         name=excluded.name, type=excluded.type, host=excluded.host, port=excluded.port, username=excluded.username,
         sticky_session_id=excluded.sticky_session_id, region=excluded.region, status=excluded.status,
         max_accounts=excluded.max_accounts, remark=excluded.remark, extra=excluded.extra`,
      [
        p.id,
        p.name,
        p.type,
        p.host,
        p.port,
        p.username || "",
        p.stickySessionId || "",
        p.region || "",
        p.status,
        p.maxAccounts || 8,
        p.remark || "",
        p.createdAt,
        json({ ...p, password: undefined }),
      ],
    );
  }
  await db.query(
    `insert into relay_settings (id, body) values ('default', $1::jsonb)
     on conflict (id) do update set body=excluded.body`,
    [json({ settings: plane.settings, savedAt: plane.savedAt })],
  );
}

export async function dbLoadPlane(): Promise<PlaneRow | null> {
  try {
    const db = await sql();
    const settingRows = await db.query<{ body: unknown }>("select body from relay_settings where id='default'");
    const accRows = await db.query<{ extra: unknown }>("select extra from relay_accounts");
    const pxRows = await db.query<{ extra: unknown }>("select extra from relay_proxies");
    if (!accRows.length && !pxRows.length && !settingRows.length) return null;
    const body = settingRows[0]?.body as { settings?: GatewaySettings; savedAt?: string } | undefined;
    const accounts = accRows.map((r) => r.extra as Account).filter(Boolean);
    const proxies = pxRows.map((r) => r.extra as Proxy).filter(Boolean);
    return {
      accounts,
      proxies,
      settings: body?.settings as GatewaySettings,
      savedAt: body?.savedAt || "",
    };
  } catch (err) {
    if (process.env.NODE_ENV === "production") throw err;
    return null;
  }
}

export async function dbUpsertJob(job: Record<string, unknown>) {
  const db = await sql();
  await db.query(
    `insert into relay_jobs
      (id, request_id, idempotency_key, status, platform, prompt, model, account_id, account_email, worker_id,
       attempt_id, lease_id, fencing_token, attempts, timeout_ms, fault, error, text, url, created_at, started_at, extra, images, exclude_ids)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24::jsonb)
     on conflict (id) do update set
       status=excluded.status, worker_id=excluded.worker_id, attempt_id=excluded.attempt_id, lease_id=excluded.lease_id,
       fencing_token=excluded.fencing_token, attempts=excluded.attempts, fault=excluded.fault, error=excluded.error,
       text=excluded.text, url=excluded.url, started_at=excluded.started_at, extra=excluded.extra`,
    [
      job.id,
      job.requestId || null,
      job.idempotencyKey || null,
      job.status,
      job.platform,
      job.prompt,
      job.model,
      job.accountId,
      job.accountEmail,
      job.workerId || job.workerName || null,
      job.attemptId || null,
      job.leaseId || null,
      job.fencingToken || null,
      job.attempts || 0,
      job.timeoutMs,
      job.fault || null,
      job.error || null,
      job.text || null,
      job.url || null,
      job.createdAt,
      job.startedAt || null,
      json(job),
      json(job.images || []),
      json(job.excludeAccountIds || []),
    ],
  );
}

export async function dbLoadJobs(): Promise<Record<string, unknown>[] | null> {
  try {
    const db = await sql();
    const rows = await db.query<{ extra: unknown }>("select extra from relay_jobs order by created_at desc limit 200");
    if (!rows.length) return null;
    return rows.map((r) => r.extra as Record<string, unknown>).filter(Boolean);
  } catch (err) {
    if (process.env.NODE_ENV === "production") throw err;
    return null;
  }
}

export async function dbLoadWorkers(): Promise<Record<string, unknown>[] | null> {
  try {
    const db = await sql();
    const rows = await db.query<{ extra: unknown; name: string; last_beat: string }>(
      "select extra, name, last_beat from relay_workers",
    );
    if (!rows.length) return [];
    return rows.map((r) => ({ ...(r.extra as object), name: r.name, lastBeat: r.last_beat }));
  } catch (err) {
    if (process.env.NODE_ENV === "production") throw err;
    return null;
  }
}

export async function dbUpsertWorker(row: {
  name: string;
  lastBeat: string;
  capacity?: number;
  activeJobs?: number;
  cpu?: number;
  ram?: number;
  browsers?: number;
  draining?: boolean;
}) {
  const db = await sql();
  await db.query(
    `insert into relay_workers (id, name, last_beat, capacity, active_jobs, cpu, ram, browsers, draining, extra)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     on conflict (name) do update set
       last_beat=excluded.last_beat, capacity=excluded.capacity, active_jobs=excluded.active_jobs,
       cpu=excluded.cpu, ram=excluded.ram, browsers=excluded.browsers, draining=excluded.draining, extra=excluded.extra`,
    [
      row.name,
      row.name,
      row.lastBeat,
      row.capacity ?? 1,
      row.activeJobs ?? 0,
      row.cpu ?? null,
      row.ram ?? null,
      row.browsers ?? 0,
      row.draining ?? false,
      json(row),
    ],
  );
}

export async function dbInsertUsage(row: Record<string, unknown>) {
  const db = await sql();
  await db.query(
    `insert into relay_usage
      (id, created_at, request_id, job_id, attempt_id, worker_id, account_id, proxy_id, key_id, key_name,
       platform, model, ok, latency_ms, prompt_tokens, completion_tokens, images, error, mode, extra)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
     on conflict (id) do nothing`,
    [
      row.id,
      row.createdAt,
      row.requestId || null,
      row.jobId || null,
      row.attemptId || null,
      row.workerId || null,
      row.accountId || null,
      row.proxyId || null,
      row.keyId || null,
      row.keyName || null,
      row.platform || null,
      row.model || null,
      row.ok ?? false,
      row.latencyMs || 0,
      row.promptTokens || 0,
      row.completionTokens || 0,
      row.images || 0,
      row.error || null,
      row.mode || null,
      json(row),
    ],
  );
}

export async function dbInsertAudit(row: { id: string; at: string; action: string; detail: string }) {
  const db = await sql();
  await db.query(
    `insert into relay_audit (id, at, action, detail) values ($1,$2,$3,$4) on conflict (id) do nothing`,
    [row.id, row.at, row.action, row.detail],
  );
}

export async function dbUpsertKey(row: ApiKeyRecord, keyHash: string) {
  const db = await sql();
  await db.query(
    `insert into relay_api_keys (id, name, key_hash, key_hint, enabled, scopes, daily_limit, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (id) do update set
       name=excluded.name, key_hash=excluded.key_hash, key_hint=excluded.key_hint, enabled=excluded.enabled,
       scopes=excluded.scopes, daily_limit=excluded.daily_limit`,
    [
      row.id,
      row.name,
      keyHash,
      `${row.key.slice(0, 10)}…${row.key.slice(-4)}`,
      row.enabled,
      row.scopes.join(","),
      row.dailyLimit,
      row.createdAt,
    ],
  );
}

export async function dbUpsertRequest(row: Record<string, unknown>) {
  const db = await sql();
  await db.query(
    `insert into relay_requests
      (id, idempotency_key, tenant_id, key_id, provider, model, status, final_attempt_id, final_error,
       created_at, started_at, completed_at, extra)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     on conflict (id) do update set
       status=excluded.status, final_attempt_id=excluded.final_attempt_id, final_error=excluded.final_error,
       started_at=excluded.started_at, completed_at=excluded.completed_at, extra=excluded.extra`,
    [
      row.id,
      row.idempotencyKey || null,
      row.tenantId || null,
      row.keyId || null,
      row.provider,
      row.model,
      row.status,
      row.finalAttemptId || null,
      row.finalError || null,
      row.createdAt,
      row.startedAt || null,
      row.completedAt || null,
      json(row),
    ],
  );
}

export async function dbUpsertAttempt(row: Record<string, unknown>) {
  const db = await sql();
  await db.query(
    `insert into relay_attempts
      (id, request_id, job_id, account_id, proxy_id, worker_id, lease_id, fencing_token, status,
       error_code, fault_domain, result, started_at, completed_at, extra)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::jsonb)
     on conflict (id) do update set
       status=excluded.status, error_code=excluded.error_code, fault_domain=excluded.fault_domain,
       result=excluded.result, completed_at=excluded.completed_at, worker_id=excluded.worker_id,
       lease_id=excluded.lease_id, fencing_token=excluded.fencing_token, extra=excluded.extra`,
    [
      row.id,
      row.requestId,
      row.jobId || null,
      row.accountId || null,
      row.proxyId || null,
      row.workerId || null,
      row.leaseId || null,
      row.fencingToken ?? null,
      row.status,
      row.errorCode || null,
      row.faultDomain || null,
      json(row.result ?? null),
      row.startedAt,
      row.completedAt || null,
      json(row),
    ],
  );
}

export async function safeDb<T>(fn: () => Promise<T>): Promise<T | null> {
  if (process.env.RELAY_SKIP_DB === "1") return null;
  try {
    return await fn();
  } catch (err) {
    if (process.env.NODE_ENV === "production") throw err;
    return null;
  }
}

export async function dbGetJob(id: string): Promise<Record<string, unknown> | null> {
  const db = await sql();
  const rows = await db.query<{ extra: unknown; status: string; fencing_token: number | null; lease_id: string | null }>(
    "select extra, status, fencing_token, lease_id from relay_jobs where id=$1",
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...(row.extra as object),
    status: row.status,
    fencingToken: row.fencing_token,
    leaseId: row.lease_id,
  } as Record<string, unknown>;
}

export async function dbGetJobByIdempotency(key: string): Promise<Record<string, unknown> | null> {
  const db = await sql();
  const rows = await db.query<{ extra: unknown }>(
    "select extra from relay_jobs where idempotency_key=$1 order by created_at desc limit 1",
    [key],
  );
  return (rows[0]?.extra as Record<string, unknown>) || null;
}

export async function dbInsertJobIdempotent(job: Record<string, unknown>): Promise<{ inserted: boolean; job: Record<string, unknown> }> {
  if (job.idempotencyKey) {
    const existing = await dbGetJobByIdempotency(String(job.idempotencyKey));
    if (existing) return { inserted: false, job: existing };
  }
  try {
    await dbUpsertJob(job);
    return { inserted: true, job };
  } catch (err) {
    if (job.idempotencyKey) {
      const existing = await dbGetJobByIdempotency(String(job.idempotencyKey));
      if (existing) return { inserted: false, job: existing };
    }
    throw err;
  }
}

export async function dbClaimJob(jobId: string, workerId: string, leaseId: string) {
  const db = await sql();
  const rows = await db.query<{ extra: unknown; fencing_token: number; attempts: number; started_at: string }>(
    `update relay_jobs
        set status='running',
            worker_id=$1,
            lease_id=$2,
            fencing_token=coalesce(fencing_token,0)+1,
            attempts=coalesce(attempts,0)+1,
            started_at=now()
      where id=$3 and status='queued'
      returning extra, fencing_token, attempts, started_at`,
    [workerId, leaseId, jobId],
  );
  const row = rows[0];
  if (!row) return null;
  const extra = {
    ...(row.extra as object),
    status: "running",
    workerId,
    workerName: workerId,
    leaseId,
    fencingToken: row.fencing_token,
    attempts: row.attempts,
    startedAt: row.started_at,
  };
  await db.query("update relay_jobs set extra=$1::jsonb where id=$2", [json(extra), jobId]);
  return extra as Record<string, unknown>;
}

export async function dbFinishJobAtomic(input: {
  jobId: string;
  leaseId: string;
  fencingToken: number;
  status: string;
  text?: string | null;
  url?: string | null;
  error?: string | null;
  fault?: string | null;
  extra: Record<string, unknown>;
}) {
  const db = await sql();
  const rows = await db.query<{ id: string }>(
    `update relay_jobs
        set status=$1, text=$2, url=$3, error=$4, fault=$5, extra=$6::jsonb
      where id=$7
        and status='running'
        and lease_id=$8
        and fencing_token=$9
      returning id`,
    [
      input.status,
      input.text ?? null,
      input.url ?? null,
      input.error ?? null,
      input.fault ?? null,
      json(input.extra),
      input.jobId,
      input.leaseId,
      input.fencingToken,
    ],
  );
  return Boolean(rows[0]);
}

export async function dbCancelJobAtomic(jobId: string, extra: Record<string, unknown>) {
  const db = await sql();
  const rows = await db.query<{ id: string }>(
    `update relay_jobs
        set status=$1, error=$2, fault=$3, extra=$4::jsonb
      where id=$5 and status in ('queued','running')
      returning id`,
    [extra.status, extra.error || null, extra.fault || null, json(extra), jobId],
  );
  return Boolean(rows[0]);
}

export async function dbListQueuedJobs(limit = 40) {
  const db = await sql();
  const rows = await db.query<{ extra: unknown }>(
    "select extra from relay_jobs where status='queued' order by created_at asc limit $1",
    [limit],
  );
  return rows.map((r) => r.extra as Record<string, unknown>).filter(Boolean);
}

export async function dbTryLockAccount(accountId: string, untilIso: string) {
  const db = await sql();
  const rows = await db.query<{ id: string }>(
    `update relay_accounts
        set locked_until=$1::timestamptz
      where id=$2
        and (locked_until is null or locked_until < now())
      returning id`,
    [untilIso, accountId],
  );
  return Boolean(rows[0]);
}

export async function dbUnlockAccount(accountId: string) {
  const db = await sql();
  await db.query("update relay_accounts set locked_until=null where id=$1", [accountId]);
}

export async function dbUnlockAllAccounts() {
  const db = await sql();
  await db.query("update relay_accounts set locked_until=null");
}

export async function dbPatchAccount(id: string, patch: Record<string, unknown>) {
  const db = await sql();
  const rows = await db.query<{ extra: unknown }>("select extra from relay_accounts where id=$1", [id]);
  if (!rows[0]) return false;
  const next = { ...(rows[0].extra as object), ...patch } as Record<string, unknown>;
  await db.query(
    `update relay_accounts set
       status=$2, fail_count=$3, total_requests=$4, locked_until=$5, last_used_at=$6,
       last_error=$7, session_version=$8, extra=$9::jsonb
     where id=$1`,
    [
      id,
      next.status,
      next.failCount || 0,
      next.totalRequests || 0,
      next.lockedUntil ?? null,
      next.lastUsedAt ?? null,
      next.lastError ?? null,
      next.sessionVersion || 0,
      json(next),
    ],
  );
  return true;
}

export async function dbReclaimDeadJobs(deadMs: number, graceMs: number, maxRetry: number) {
  const db = await sql();
  const rows = await db.query<{ extra: unknown; id: string; attempts: number }>(
    `select extra, id, attempts from relay_jobs
      where status='running'
        and started_at is not null
        and extract(epoch from (now() - started_at)) * 1000 > $1`,
    [Math.max(deadMs, graceMs)],
  );
  const recovered: Record<string, unknown>[] = [];
  for (const row of rows) {
    const extra = { ...(row.extra as object) } as Record<string, unknown>;
    const attempts = Number(row.attempts || extra.attempts || 1);
    if (attempts < maxRetry) {
      extra.status = "queued";
      extra.error = "WORKER_CRASH: 执行器掉线，已回队";
      extra.fault = "worker";
      extra.errorCode = "WORKER_CRASH";
      extra.workerName = undefined;
      extra.workerId = undefined;
      extra.startedAt = undefined;
      extra.lease = undefined;
      await db.query(
        `update relay_jobs set status='queued', worker_id=null, lease_id=null, extra=$1::jsonb, error=$2, fault='worker'
          where id=$3 and status='running'`,
        [json(extra), extra.error, row.id],
      );
    } else {
      extra.status = "dead";
      extra.error = "WORKER_CRASH: dead-letter";
      extra.fault = "worker";
      extra.errorCode = "WORKER_CRASH";
      await db.query(
        `update relay_jobs set status='dead', extra=$1::jsonb, error=$2, fault='worker'
          where id=$3 and status='running'`,
        [json(extra), extra.error, row.id],
      );
    }
    recovered.push(extra);
  }
  return recovered;
}

export async function dbInsertRequestIdempotent(row: Record<string, unknown>): Promise<{ request: Record<string, unknown>; replay: boolean }> {
  const db = await sql();
  const key = row.idempotencyKey ? String(row.idempotencyKey) : null;
  if (key) {
    const hit = await db.query<{ extra: unknown; id: string }>(
      "select extra, id from relay_requests where idempotency_key=$1 limit 1",
      [key],
    );
    if (hit[0]) return { request: (hit[0].extra as Record<string, unknown>) || row, replay: true };
  }
  try {
    await dbUpsertRequest(row);
    return { request: row, replay: false };
  } catch (err) {
    if (key) {
      const hit = await db.query<{ extra: unknown }>(
        "select extra from relay_requests where idempotency_key=$1 limit 1",
        [key],
      );
      if (hit[0]) return { request: (hit[0].extra as Record<string, unknown>) || row, replay: true };
    }
    throw err;
  }
}

export async function dbGetRequest(id: string) {
  const db = await sql();
  const rows = await db.query<{ extra: unknown }>("select extra from relay_requests where id=$1", [id]);
  return (rows[0]?.extra as Record<string, unknown>) || null;
}

export async function dbListRequests(limit = 50) {
  const db = await sql();
  const rows = await db.query<{ extra: unknown }>(
    "select extra from relay_requests order by created_at desc limit $1",
    [limit],
  );
  return rows.map((r) => r.extra as Record<string, unknown>).filter(Boolean);
}
