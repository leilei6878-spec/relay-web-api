import { createFileRoute } from "@tanstack/react-router";
import { assertAdmin, bearerToken } from "@/lib/authz";
import { getCircuit } from "@/lib/circuit";
import { readControlPlane } from "@/lib/control-plane";
import { listJobs } from "@/lib/job-queue";
import { prometheusText } from "@/lib/metrics";
import { resilienceSnapshot } from "@/lib/resilience-metrics";

export const Route = createFileRoute("/metrics")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = process.env.RELAY_METRICS_TOKEN?.trim();
        if (token) {
          if (bearerToken(request) !== token) {
            const auth = await assertAdmin(request);
            if (!auth.ok) return new Response("unauthorized\n", { status: 401 });
          }
        }
        const { jobs, workers } = await listJobs();
        const plane = await readControlPlane();
        const now = Date.now();
        const online = workers.filter((w) => now - Date.parse(w.lastBeat) < 20_000).length;
        const chatgpt = await getCircuit("chatgpt");
        const gemini = await getCircuit("gemini");
        const res = resilienceSnapshot();
        const text = prometheusText({
          queue_depth: jobs.filter((j) => j.status === "queued" || j.status === "running").length,
          active_jobs: jobs.filter((j) => j.status === "running").length,
          active_leases: jobs.filter((j) => j.status === "running" && j.leaseId).length,
          healthy_accounts: plane.accounts.filter((a) => a.status === "healthy").length,
          cooling_accounts: plane.accounts.filter((a) => a.status === "cooling").length,
          invalid_accounts: plane.accounts.filter((a) => a.status === "invalid").length,
          worker_online: online,
          provider_health_chatgpt: chatgpt.state === "OPEN" ? 0 : chatgpt.state === "DEGRADED" ? 0.5 : 1,
          provider_health_gemini: gemini.state === "OPEN" ? 0 : gemini.state === "DEGRADED" ? 0.5 : 1,
          failovers: res.failover,
          retries: res.retry,
          stale_results_rejected: res.stale_rejected,
          provider_errors: res.provider_circuit_open,
        });
        return new Response(text, {
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      },
    },
  },
});
