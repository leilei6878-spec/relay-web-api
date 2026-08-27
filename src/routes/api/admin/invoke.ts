import { createFileRoute } from "@tanstack/react-router";
import { assertAdmin } from "@/lib/authz";
import { primaryApiKey } from "@/lib/api-keys";
import { dispatchAdminInvoke } from "@/lib/invoke-dispatch";

export const Route = createFileRoute("/api/admin/invoke")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: { message: auth.error } }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as { path?: string; payload?: unknown };
        const key = await primaryApiKey();
        const inner = new AbortController();
        const killer = setTimeout(() => inner.abort(), 165_000);
        try {
          return await dispatchAdminInvoke({
            path: body.path || "",
            payload: body.payload,
            apiKey: key,
            signal: inner.signal,
          });
        } finally {
          clearTimeout(killer);
        }
      },
    },
  },
});
