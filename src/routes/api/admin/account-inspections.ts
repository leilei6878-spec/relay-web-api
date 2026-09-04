import { createFileRoute } from "@tanstack/react-router";
import {
  commandAccountInspection,
  createAccountInspection,
  forceCloseAccountInspection,
  getAccountInspection,
  listAccountInspections,
  readInspectionFrame,
  secureInspectionRequest,
  type InspectionCommand,
} from "@/lib/account-inspections";
import { assertAdmin } from "@/lib/authz";

export const Route = createFileRoute("/api/admin/account-inspections")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const search = new URL(request.url).searchParams;
        const id = search.get("id") || "";
        const token = request.headers.get("x-inspection-token") || search.get("token") || "";
        if (search.get("frame") === "1") {
          const frame = await readInspectionFrame(id, token);
          return frame
            ? new Response(frame, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } })
            : Response.json({ error: "画面尚未就绪" }, { status: 404 });
        }
        if (id) {
          const row = await getAccountInspection(id, token);
          return row ? Response.json(row) : Response.json({ error: "查看会话不存在或令牌无效" }, { status: 404 });
        }
        return Response.json({ inspections: await listAccountInspections(search.get("accountId") || undefined) });
      },
      POST: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as {
          action?: "start" | "command" | "force-close";
          accountId?: string;
          mode?: "view" | "maintenance";
          id?: string;
          token?: string;
          command?: InspectionCommand;
        };
        if (body.action === "force-close") {
          const result = await forceCloseAccountInspection(body.accountId || "", "admin");
          return Response.json(result, { status: result.ok ? 200 : result.status });
        }
        if (body.action === "command" && body.command) {
          const result = await commandAccountInspection(body.id || "", body.token || "", body.command);
          return Response.json(result, { status: result.ok ? 200 : result.status });
        }
        const result = await createAccountInspection({
          accountId: body.accountId || "",
          mode: body.mode,
          secure: secureInspectionRequest(request),
          requestedBy: "admin",
        });
        return Response.json(result, { status: result.ok ? 202 : result.status });
      },
    },
  },
});
