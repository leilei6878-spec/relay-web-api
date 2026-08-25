import { createFileRoute } from "@tanstack/react-router";
import { assertApiKey, patchAccount, readControlPlane } from "@/lib/control-plane";
import { probeSessionFile } from "@/lib/session-probe";

export const Route = createFileRoute("/api/accounts/probe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await assertApiKey(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const plane = await readControlPlane();
        let checked = 0;
        let demoted = 0;
        const details: { email: string; ok: boolean; reason?: string; warning?: string }[] = [];
        for (const account of plane.accounts) {
          if (account.status !== "healthy" && account.status !== "cooling") continue;
          checked += 1;
          const session = await probeSessionFile(account.id, account.platform);
          const proxy = plane.proxies.find((p) => p.id === account.proxyId);
          const proxyOk = !plane.settings.enforceProxy || (proxy && proxy.status === "active");
          const ok = session.ok && Boolean(proxyOk);
          const reason = !session.ok ? session.reason : !proxyOk ? "代理不可用" : undefined;
          const warning = session.ok ? session.warning : undefined;
          await patchAccount(account.id, {
            lastProbeAt: new Date().toISOString(),
            lastError: ok ? null : reason || "探活失败",
            sessionWarning: ok ? warning || null : null,
            status: ok ? "healthy" : "invalid",
          });
          if (!ok) demoted += 1;
          details.push({ email: account.email, ok, reason, warning });
        }
        return Response.json({ checked, demoted, details });
      },
    },
  },
});
