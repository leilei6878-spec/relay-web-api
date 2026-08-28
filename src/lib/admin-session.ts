import {
  adminCookieHeader,
  allowAutomaticAdminLogin,
  assertAdmin,
  ensureAdminToken,
} from "./authz.ts";
import {
  adminLoginAttemptKey,
  adminLoginBlocked,
  recordAdminLoginResult,
  verifyAdminCredentials,
} from "./admin-password.ts";

export async function handleAdminSessionGet(request: Request) {
  const auth = await assertAdmin(request);
  if (auth.ok) return Response.json({ ok: true, role: "admin" });
  if (!allowAutomaticAdminLogin()) {
    return Response.json({ ok: false, error: auth.error }, { status: 401 });
  }
  const token = await ensureAdminToken();
  const https = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return new Response(JSON.stringify({ ok: true, role: "admin", auto: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": adminCookieHeader(token, https),
    },
  });
}

export async function handleAdminSessionPost(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    token?: string;
    username?: string;
    password?: string;
  };
  const token = await ensureAdminToken();
  const tokenOk = Boolean(body.token && body.token === token);
  const attemptKey = adminLoginAttemptKey(request);
  if (!tokenOk && adminLoginBlocked(attemptKey)) {
    return Response.json(
      { ok: false, error: "登录失败次数过多，请稍后重试" },
      { status: 429, headers: { "Retry-After": "900" } },
    );
  }
  const credentialsOk = verifyAdminCredentials(body.username || "", body.password || "");
  if (!tokenOk && !credentialsOk) {
    recordAdminLoginResult(attemptKey, false);
    return Response.json({ ok: false, error: "管理员账号或密码错误" }, { status: 401 });
  }
  recordAdminLoginResult(attemptKey, true);
  const https = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return new Response(JSON.stringify({ ok: true, role: "admin" }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": adminCookieHeader(token, https),
    },
  });
}
