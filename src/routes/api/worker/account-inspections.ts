import { createFileRoute } from "@tanstack/react-router";
import { saveInspectionFrame, workerInspectionPoll, workerInspectionStatus } from "@/lib/account-inspections";
import { assertWorker } from "@/lib/authz";

export const Route = createFileRoute("/api/worker/account-inspections")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertWorker(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const search = new URL(request.url).searchParams;
        return Response.json(await workerInspectionPoll(search.get("id") || "", Number(search.get("afterSeq") || 0)));
      },
      POST: async ({ request }) => {
        const auth = await assertWorker(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const id = request.headers.get("x-inspection-id") || new URL(request.url).searchParams.get("id") || "";
        const type = request.headers.get("content-type") || "";
        if (type.includes("image/jpeg") || type.includes("image/png")) {
          const result = await saveInspectionFrame(id, Buffer.from(await request.arrayBuffer()));
          return Response.json(result, { status: result.ok ? 200 : result.status });
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const result = await workerInspectionStatus(id, body);
        return Response.json(result, { status: result.ok ? 200 : result.status });
      },
    },
  },
});
