import { createFileRoute } from "@tanstack/react-router";
import { bootProductionGuard, runProductionReadinessCheck } from "@/lib/production-guard";
import { runLiveReadinessCheck } from "@/lib/live-readiness";
import { releaseIdentity } from "@/lib/release";

export const Route = createFileRoute("/readyz")({
  server: {
    handlers: {
      GET: async () => {
        const release = releaseIdentity();
        const identity = {
          version: release.version,
          schema: release.schema,
          commit: release.commit,
          buildTime: release.buildTime,
          release,
        };
        try {
          bootProductionGuard();
        } catch (err) {
          return Response.json(
            {
              ready: false,
              ...identity,
              error: err instanceof Error ? err.message : "fail-closed",
            },
            { status: 503 },
          );
        }
        const env = runProductionReadinessCheck();
        if (env.production && !env.ready) {
          return Response.json({ ...identity, ...env }, { status: 503 });
        }
        try {
          const live = await runLiveReadinessCheck();
          const status = live.production && !live.ready ? 503 : 200;
          return Response.json({ ...identity, ...live }, { status });
        } catch {
          return Response.json({ ...identity, ...env });
        }
      },
    },
  },
});
