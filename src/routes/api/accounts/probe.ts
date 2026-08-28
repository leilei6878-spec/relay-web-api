import { createFileRoute } from "@tanstack/react-router";
import { createAccountCheckRun } from "@/lib/account-checks";
import { assertAdmin } from "@/lib/authz";

export const Route = createFileRoute("/api/accounts/probe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const result = await createAccountCheckRun({
          trigger: "manual",
          requestedBy: "admin-compat",
          scope: {},
          levels: ["static", "proxy", "live"],
        });
        return Response.json(result, { status: result.ok ? 202 : result.status });
      },
    },
  },
});
