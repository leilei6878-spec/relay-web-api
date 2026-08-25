import { createFileRoute } from "@tanstack/react-router";
import { cors, handleImage } from "./generations";

export const Route = createFileRoute("/v1/images/edits")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors() }),
      POST: async ({ request }) => handleImage(request),
    },
  },
});
