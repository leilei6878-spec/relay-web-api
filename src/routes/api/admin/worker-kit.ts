import { createFileRoute } from "@tanstack/react-router";
import { assertAdmin, ensureWorkerToken } from "@/lib/authz";

export const Route = createFileRoute("/api/admin/worker-kit")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const token = await ensureWorkerToken();
        const origin = new URL(request.url).origin;
        return Response.json({
          workerToken: token,
          gateway: origin,
          name: "pc-1",
        });
      },
    },
  },
});
