import { createFileRoute } from "@tanstack/react-router";
import { assertAdmin } from "@/lib/authz";
import { primaryApiKey } from "@/lib/api-keys";

export const Route = createFileRoute("/api/admin/invoke")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: { message: auth.error } }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as { path?: string; payload?: unknown };
        const allowed = new Set(["/v1/chat/completions", "/v1/images/generations", "/v1/images/edits", "/v1/responses", "/v1/models"]);
        const path = allowed.has(body.path || "") ? body.path! : "/v1/chat/completions";
        const key = await primaryApiKey();
        const origin = new URL(request.url).origin;
        const res = await fetch(`${origin}${path}`, {
          method: path === "/v1/models" ? "GET" : "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: path === "/v1/models" ? undefined : JSON.stringify(body.payload || {}),
        });
        const ctype = res.headers.get("content-type") || "application/json";
        if (ctype.includes("text/event-stream") && res.body) {
          return new Response(res.body, {
            status: res.status,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
            },
          });
        }
        const text = await res.text();
        return new Response(text, { status: res.status, headers: { "Content-Type": ctype } });
      },
    },
  },
});
