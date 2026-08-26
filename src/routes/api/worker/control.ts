import { createFileRoute } from "@tanstack/react-router";
import { assertAdmin } from "@/lib/authz";
import { markWorkerDraining } from "@/lib/job-queue";
import { serverWorkerStatus, startServerWorker, stopServerWorker } from "@/lib/server-worker";

export const Route = createFileRoute("/api/worker/control")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        return Response.json(await serverWorkerStatus());
      },
      POST: async ({ request }) => {
        const auth = await assertAdmin(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as { action?: string };
        const origin = new URL(request.url).origin;
        const gw = origin.includes("localhost") ? "http://127.0.0.1:8080" : origin;
        if (body.action === "stop") return Response.json(await stopServerWorker());
        if (body.action === "drain") {
          await markWorkerDraining("server-1", true);
          return Response.json({ ok: true, draining: true, name: "server-1" });
        }
        const started = await startServerWorker(gw);
        if (!started.ok) return Response.json({ error: started.error }, { status: 500 });
        return Response.json(started);
      },
    },
  },
});
