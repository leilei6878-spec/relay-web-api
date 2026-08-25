import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey } from "@/lib/control-plane";
import { ensureServerWorker, serverWorkerStatus, startServerWorker, stopServerWorker } from "@/lib/server-worker";

export const Route = createFileRoute("/api/worker/control")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        await ensureServerWorker(origin.includes("localhost") ? "http://127.0.0.1:8080" : origin);
        return Response.json(await serverWorkerStatus());
      },
      POST: async ({ request }) => {
        const auth = await assertApiKey(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as { action?: string };
        const origin = new URL(request.url).origin;
        const gw = origin.includes("localhost") ? "http://127.0.0.1:8080" : origin;
        if (body.action === "stop") return Response.json(await stopServerWorker());
        const started = await startServerWorker(gw);
        if (!started.ok) return Response.json({ error: started.error }, { status: 500 });
        return Response.json(started);
      },
    },
  },
});
