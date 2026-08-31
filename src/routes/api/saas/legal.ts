import { createFileRoute } from "@tanstack/react-router";
import { effectiveCommercialEnv } from "@/lib/commercial-config";
import { legalDocumentMetadata } from "@/lib/legal-documents";

export const Route = createFileRoute("/api/saas/legal")({
  server: {
    handlers: {
      GET: async () => {
        const env = await effectiveCommercialEnv();
        return Response.json(legalDocumentMetadata(env), {
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
      },
    },
  },
});

