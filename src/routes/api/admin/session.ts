import { createFileRoute } from "@tanstack/react-router";
import { adminCookieHeader, ensureAdminToken } from "@/lib/authz";
import { handleAdminSessionGet } from "@/lib/admin-session";

export const Route = createFileRoute("/api/admin/session")({
  server: {
    handlers: {
      GET: ({ request }) => handleAdminSessionGet(request),
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
