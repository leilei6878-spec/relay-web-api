import { createFileRoute } from "@tanstack/react-router";
import { availabilityAnalytics, captureAvailabilitySample } from "@/lib/account-analytics";
import { assertAdmin } from "@/lib/authz";

export const Route = createFileRoute("/api/admin/account-analytics")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const days = Number(new URL(request.url).searchParams.get("days") || 30);
        return Response.json(await availabilityAnalytics(days));
      },
      POST: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        return Response.json(await captureAvailabilitySample());
      },
    },
  },
});
