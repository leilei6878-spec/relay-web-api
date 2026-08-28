import { createFileRoute } from "@tanstack/react-router";
import {
  accountOperationalView,
  bulkUpdateAccountOperations,
  updateAccountOperations,
  type AccountExpiryFilter,
  type AccountQuery,
} from "@/lib/account-operations";
import { assertAdmin } from "@/lib/authz";
import { readControlPlane } from "@/lib/control-plane";
import type { AccountIpState, AccountStatus, Platform } from "@/lib/types";

function queryFrom(request: Request): AccountQuery {
  const search = new URL(request.url).searchParams;
  return {
    q: search.get("q") || "",
    platform: (search.get("platform") || "all") as "all" | Platform,
    status: (search.get("status") || "all") as "all" | AccountStatus,
    proxyId: search.get("proxyId") || "",
    batch: search.get("batch") || "",
    ipState: (search.get("ipState") || "all") as "all" | AccountIpState,
    expiry: (search.get("expiry") || "all") as AccountExpiryFilter,
    sort: (search.get("sort") || "createdAt") as AccountQuery["sort"],
    direction: search.get("direction") === "asc" ? "asc" : "desc",
    page: Number(search.get("page") || 1),
    pageSize: Number(search.get("pageSize") || 50),
  };
}

export const Route = createFileRoute("/api/admin/account-operations")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        return Response.json(accountOperationalView(await readControlPlane(), queryFrom(request)));
      },
      PATCH: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as {
          id?: string;
          ids?: string[];
          patch?: Record<string, unknown>;
        };
        const result = body.id
          ? await updateAccountOperations(body.id, body.patch || {})
          : await bulkUpdateAccountOperations(body.ids || [], body.patch || {});
        return Response.json(result, { status: result.ok ? 200 : result.status });
      },
    },
  },
});
