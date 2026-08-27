import {
  adminCookieHeader,
  allowAutomaticAdminLogin,
  assertAdmin,
  ensureAdminToken,
} from "./authz.ts";

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
