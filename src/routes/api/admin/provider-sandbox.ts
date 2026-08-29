import { createFileRoute } from "@tanstack/react-router";
import { assertAdminMfa } from "@/lib/authz";
import { listProviderSandboxRuns, runProviderSandbox } from "@/lib/provider-sandbox";
import type { CommercialCapability } from "@/lib/commercial-types";
import type { OfficialProvider } from "@/lib/official-providers";

export const Route = createFileRoute("/api/admin/provider-sandbox")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdminMfa(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        return Response.json({
          hardGateOpen: process.env.RELAY_ALLOW_LIVE_PROVIDER_CANARY === "1",
          maxChargeMinor: Math.max(1, Math.min(10_000, Number(process.env.RELAY_CANARY_MAX_CHARGE_MINOR || 100))),
          runs: await listProviderSandboxRuns(),
        }, { headers: { "Cache-Control": "no-store" } });
      },
      POST: async ({ request }) => {
        const auth = await assertAdminMfa(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        try {
          const run = await runProviderSandbox({
            provider: String(body.provider || "") as OfficialProvider,
            model: String(body.model || ""),
            capability: String(body.capability || "") as CommercialCapability,
            currency: String(body.currency || "USD"),
            confirmation: String(body.confirmation || ""),
            actor: "admin",
          });
          return Response.json({ ok: run.status === "passed", run }, { status: run.status === "passed" ? 200 : 502 });
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : "PROVIDER_SANDBOX_FAILED" }, { status: 400 });
        }
      },
    },
  },
});
