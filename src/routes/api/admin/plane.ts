import { createFileRoute } from "@tanstack/react-router";
import { assertAdmin } from "@/lib/authz";
import { readControlPlane, writeControlPlane } from "@/lib/control-plane";
import { publicProxy } from "@/lib/secrets";

export const Route = createFileRoute("/api/admin/plane")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const plane = await readControlPlane();
        return Response.json({
          ...plane,
          proxies: plane.proxies.map((p) => publicProxy(p)),
        });
      },
      PUT: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json()) as Parameters<typeof writeControlPlane>[0];
        return Response.json(await writeControlPlane(body));
      },
    },
  },
});
