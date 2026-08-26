import { createFileRoute } from "@tanstack/react-router";
import { assertAdmin } from "@/lib/authz";
import { bootProductionGuard } from "@/lib/production-guard";
import { runLiveReadinessCheck } from "@/lib/live-readiness";

export const Route = createFileRoute("/internal/readiness")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        try {
          bootProductionGuard();
        } catch (err) {
          return Response.json(
            { ready: false, error: err instanceof Error ? err.message : "fail-closed" },
            { status: 503 },
          );
        }
        const report = await runLiveReadinessCheck();
        return Response.json(report, { status: report.production && !report.ready ? 503 : 200 });
      },
    },
  },
});
