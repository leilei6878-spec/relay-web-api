import { createFileRoute } from "@tanstack/react-router";
import { bootProductionGuard, runProductionReadinessCheck } from "@/lib/production-guard";
import { runLiveReadinessCheck } from "@/lib/live-readiness";
import { APP_VERSION, SCHEMA_VERSION } from "@/lib/release";

export const Route = createFileRoute("/readyz")({
  server: {
    handlers: {
      GET: async () => {
        try {
          bootProductionGuard();
        } catch (err) {
          return Response.json(
            {
              ready: false,
              version: APP_VERSION,
              schema: SCHEMA_VERSION,
              error: err instanceof Error ? err.message : "fail-closed",
            },
            { status: 503 },
          );
        }
        const env = runProductionReadinessCheck();
        if (env.production && !env.ready) {
          return Response.json({ version: APP_VERSION, schema: SCHEMA_VERSION, ...env }, { status: 503 });
        }
        try {
          const live = await runLiveReadinessCheck();
          const status = live.production && !live.ready ? 503 : 200;
          return Response.json({ version: APP_VERSION, schema: SCHEMA_VERSION, ...live }, { status });
        } catch {
          return Response.json({ version: APP_VERSION, schema: SCHEMA_VERSION, ...env });
        }
      },
    },
  },
});
