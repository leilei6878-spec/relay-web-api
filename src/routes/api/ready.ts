import { createFileRoute } from "@tanstack/react-router";
import { bootProductionGuard, runProductionReadinessCheck } from "@/lib/production-guard";
import { coordBackend } from "@/lib/coord";
import { persistenceMode } from "@/lib/persist-mode";
import { objectStoreConfigured } from "@/lib/media-store";
import { dbSource } from "@/lib/db";

export const Route = createFileRoute("/api/ready")({
  server: {
    handlers: {
      GET: async () => {
        try {
          bootProductionGuard();
        } catch (err) {
          return Response.json(
            { ready: false, production: true, error: err instanceof Error ? err.message : "fail-closed" },
            { status: 503 },
          );
        }
        const report = runProductionReadinessCheck();
        const body = {
          ...report,
          backend: {
            db: dbSource,
            persist: persistenceMode(),
            coord: coordBackend(),
            media: objectStoreConfigured() ? "object" : "local",
          },
          note: "Authenticated live pings live at GET /internal/readiness",
        };
        const status = report.production && !report.ready ? 503 : 200;
        return Response.json(body, { status });
      },
    },
  },
});
