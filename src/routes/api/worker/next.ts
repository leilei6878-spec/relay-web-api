import { createFileRoute } from "@tanstack/react-router";
import { assertWorker } from "@/lib/authz";
import { beatWorker, claimNext } from "@/lib/job-queue";

export const Route = createFileRoute("/api/worker/next")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertWorker(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const name = request.headers.get("x-worker-name") || "server-1";
        const stats = {
          capacity: Number(request.headers.get("x-worker-capacity") || "0") || undefined,
          activeJobs: Number(request.headers.get("x-worker-active") || "0") || undefined,
          cpu: Number(request.headers.get("x-worker-cpu") || "0") || undefined,
          ram: Number(request.headers.get("x-worker-ram") || "0") || undefined,
          browsers: Number(request.headers.get("x-worker-browsers") || "0") || undefined,
          draining: request.headers.get("x-worker-drain") === "1",
        };
        await beatWorker(name, stats);
        if (request.headers.get("x-worker-beat-only") === "1") {
          const jobId = request.headers.get("x-job-id") || "";
          const accountId = request.headers.get("x-account-id") || "";
          const { renewJobLeases, parseActiveJobsHeader } = await import("@/lib/coord");
          const pairs = parseActiveJobsHeader(request.headers.get("x-active-jobs"), jobId, accountId);
          for (const p of pairs) {
            await renewJobLeases(p.jobId, p.accountId, 120_000, name);
          }
          return Response.json({ ok: true, beat: true, name, renewed: pairs.length });
        }
        const next = await claimNext(name, stats);
        return Response.json(next);
      },
    },
  },
});
