import { createFileRoute } from "@tanstack/react-router";
import { acceptTenantInvite } from "@/lib/saas-members";
import { trustedSaasOrigin } from "@/lib/saas-auth";

export const Route = createFileRoute("/api/saas/invite")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!trustedSaasOrigin(request)) return Response.json({ ok: false, error: "INVALID_ORIGIN" }, { status: 403 });
        const body = (await request.json().catch(() => ({}))) as { token?: string; name?: string; password?: string };
        try {
          return Response.json(await acceptTenantInvite({ token: body.token || "", name: body.name || "", password: body.password || "" }));
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : "INVITE_ACCEPT_FAILED" }, { status: 400 });
        }
      },
    },
  },
});
