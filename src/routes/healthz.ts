import { createFileRoute } from "@tanstack/react-router";
import { APP_VERSION, SCHEMA_VERSION } from "@/lib/release";

export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          status: "alive",
          version: APP_VERSION,
          schema: SCHEMA_VERSION,
        }),
    },
  },
});
