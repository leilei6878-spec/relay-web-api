import { createFileRoute } from "@tanstack/react-router";
import {
  cancelAccountCheckRun,
  createAccountCheckRun,
  getAccountCheckRun,
  listAccountChecks,
} from "@/lib/account-checks";
import { assertAdmin } from "@/lib/authz";

export const Route = createFileRoute("/api/admin/account-checks")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const search = new URL(request.url).searchParams;
        const runId = search.get("runId");
        if (runId) {
          const result = await getAccountCheckRun(runId);
          return result ? Response.json(result) : Response.json({ error: "检查任务不存在" }, { status: 404 });
        }
        return Response.json(await listAccountChecks(search.get("accountId") || undefined, Math.min(200, Number(search.get("limit") || 100))));
      },
      POST: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as {
          action?: "start" | "cancel";
          runId?: string;
          scope?: Record<string, unknown>;
          levels?: unknown;
        };
        if (body.action === "cancel") {
          const result = await cancelAccountCheckRun(body.runId || "");
          return Response.json(result, { status: result.ok ? 200 : result.status });
        }
        const result = await createAccountCheckRun({
          trigger: "manual",
          requestedBy: "admin",
          scope: body.scope,
          levels: body.levels,
        });
        return Response.json(result, { status: result.ok ? 202 : result.status });
      },
    },
  },
});
