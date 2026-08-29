import {
  adminCookieHeader,
  allowAutomaticAdminLogin,
  assertAdmin,
  clearAdminCookieHeader,
  ensureAdminToken,
  readCookie,
  trustedMutationOrigin,
} from "./authz.ts";
import {
  adminLoginAttemptKey,
  adminLoginBlocked,
  adminMfaConfigured,
  allowAdminTokenSessionLogin,
  recordAdminLoginResult,
  verifyAdminCredentials,
  verifyAdminRecoveryToken,
  verifyAdminTotp,
} from "./admin-password.ts";
import { createAdminSession, revokeAdminSession } from "./admin-sessions.ts";
import { effectiveCommercialEnv } from "./commercial-config.ts";
import { coordDel, coordGet, coordIncr } from "./coord.ts";
import { getSql, type Sql } from "./db.ts";

type DbLike = Pick<Sql, "query">;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;

function secureRequest(request: Request) {
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}

function distributedAttemptKey(attemptKey: string) {
  return `admin:login:${attemptKey}`;
}

async function loginBlocked(attemptKey: string) {
  if (adminLoginBlocked(attemptKey)) return true;
  return Number(await coordGet(distributedAttemptKey(attemptKey)) || 0) >= MAX_FAILURES;
}

async function recordLoginResult(attemptKey: string, ok: boolean) {
  recordAdminLoginResult(attemptKey, ok);
  if (ok) await coordDel(distributedAttemptKey(attemptKey));
  else await coordIncr(distributedAttemptKey(attemptKey), LOGIN_WINDOW_MS);
}

export async function handleAdminSessionGet(request: Request, db?: DbLike) {
  const auth = await assertAdmin(request, db);
  if (auth.ok) return Response.json({ ok: true, role: "admin", mfaVerified: auth.principal.mfaVerified, authMethod: auth.principal.authMethod });
  if (!allowAutomaticAdminLogin()) {
    return Response.json({ ok: false, error: auth.error }, { status: 401 });
  }
  const sql = db || await getSql();
  const session = await createAdminSession({ request, authMethod: "development", mfaVerified: false }, sql);
  return new Response(JSON.stringify({ ok: true, role: "admin", auto: true, mfaVerified: false }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": adminCookieHeader(session.token, secureRequest(request), session.maxAge),
    },
  });
}

export async function handleAdminSessionPost(request: Request, db?: DbLike) {
  const body = (await request.json().catch(() => ({}))) as {
    token?: string;
    username?: string;
    password?: string;
    totp?: string;
  };
  const sql = db || await getSql();
  const env = await effectiveCommercialEnv(process.env, sql);
  const attemptKey = adminLoginAttemptKey(request);
  if (await loginBlocked(attemptKey)) {
    return Response.json(
      { ok: false, error: "登录失败次数过多，请稍后重试" },
      { status: 429, headers: { "Retry-After": "900" } },
    );
  }

  const expectedToken = await ensureAdminToken();
  const tokenOk = Boolean(
    body.token &&
    allowAdminTokenSessionLogin(request, env) &&
    verifyAdminRecoveryToken(body.token, expectedToken),
  );
  const credentialsOk = verifyAdminCredentials(body.username || "", body.password || "", env);
  const mfaRequired = env.RELAY_REQUIRE_ADMIN_MFA === "1" || env.RELAY_COMMERCIAL_ENABLED === "1";
  const mfaConfigured = adminMfaConfigured(env);
  const totpOk = mfaConfigured && verifyAdminTotp(body.totp || "", env);

  if (!tokenOk && (!credentialsOk || (mfaRequired && !totpOk))) {
    await recordLoginResult(attemptKey, false);
    if (credentialsOk && mfaRequired && !mfaConfigured) {
      return Response.json({ ok: false, error: "管理员 MFA 已强制，但 TOTP Secret 无效" }, { status: 503 });
    }
    return Response.json({ ok: false, error: "管理员账号、密码或验证码错误" }, { status: 401 });
  }

  await recordLoginResult(attemptKey, true);
  const authMethod = tokenOk ? "recovery_token" as const : "password" as const;
  const session = await createAdminSession({
    request,
    authMethod,
    mfaVerified: tokenOk || totpOk,
    env,
  }, sql);
  return new Response(JSON.stringify({ ok: true, role: "admin", mfaVerified: tokenOk || totpOk, authMethod }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": adminCookieHeader(session.token, secureRequest(request), session.maxAge),
    },
  });
}

export async function handleAdminSessionDelete(request: Request, db?: DbLike) {
  if (!trustedMutationOrigin(request)) return Response.json({ ok: false, error: "管理请求来源校验失败" }, { status: 403 });
  const token = readCookie(request, "relay_admin");
  if (token) await revokeAdminSession(token, db);
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearAdminCookieHeader(secureRequest(request)),
    },
  });
}
