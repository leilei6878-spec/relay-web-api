import { createFileRoute } from "@tanstack/react-router";
import { assertAdminMfa } from "@/lib/authz";
import {
  activateCommercialConfigVersion,
  createCommercialConfigVersion,
  listCommercialConfig,
  testCommercialConfigVersion,
} from "@/lib/commercial-config";

export const Route = createFileRoute("/api/admin/commercial-config")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdminMfa(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        return Response.json({ catalog: await listCommercialConfig() }, { headers: { "Cache-Control": "no-store" } });
      },
      POST: async ({ request }) => {
        const auth = await assertAdminMfa(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const action = String(body.action || "");
        try {
          const actor = "admin";
          const result = action === "create"
            ? await createCommercialConfigVersion({ key: String(body.key || ""), value: body.value, reason: String(body.reason || ""), actor })
            : action === "test"
              ? await testCommercialConfigVersion(String(body.id || ""), actor)
              : ["activate", "rollback"].includes(action)
                ? await activateCommercialConfigVersion(String(body.id || ""), actor)
                : (() => { throw new Error("CONFIG_ACTION_UNKNOWN"); })();
          return Response.json({ ok: true, result });
        } catch (error) {
          const message = error instanceof Error ? error.message : "COMMERCIAL_CONFIG_FAILED";
          return Response.json({ ok: false, error: message }, { status: /NOT_FOUND/.test(message) ? 404 : 400 });
        }
      },
    },
  },
});
