import { createFileRoute } from "@tanstack/react-router";
import { releaseIdentity } from "@/lib/release";

export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: async () => {
        const release = releaseIdentity();
        return Response.json({
          ok: true,
          status: "alive",
          version: release.version,
          schema: release.schema,
          commit: release.commit,
          buildTime: release.buildTime,
          release,
        });
      },
    },
  },
});
