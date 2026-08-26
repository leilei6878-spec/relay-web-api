import { createFileRoute } from "@tanstack/react-router";
import { adminCookieHeader, assertAdmin, ensureAdminToken } from "@/lib/authz";
import { isProduction } from "@/lib/env-mode";

export const Route = createFileRoute("/api/admin/session")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (auth.ok) return Response.json({ ok: true, role: "admin" });
        const auto = process.env.RELAY_REQUIRE_ADMIN_LOGIN !== "1" && !isProduction();
        if (!auto) return Response.json({ ok: false, error: auth.error }, { status: 401 });
        const token = await ensureAdminToken();
        const https = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
        return new Response(JSON.stringify({ ok: true, role: "admin", auto: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": adminCookieHeader(token, https),
          },
        });
      },
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as { token?: string };
        const token = await ensureAdminToken();
        if (!body.token || body.token !== token) {
          return Response.json({ ok: false, error: "管理员凭证无效" }, { status: 401 });
        }
        const https = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
        return new Response(JSON.stringify({ ok: true, role: "admin" }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": adminCookieHeader(token, https),
          },
        });
      },
    },
  },
});
