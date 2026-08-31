import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SaasMfaDialog } from "@/components/saas-mfa-dialog";
import { SaasSessionSecurity } from "@/components/saas-session-security";
import { SaasShell } from "@/components/saas-shell";

export const Route = createFileRoute("/saas/security-center")({ component: SecurityCenter });

type Session = {
  user: { id: string; email: string; name: string; mfaEnabled: boolean };
  tenant: { id: string; name: string; status: string; role: string };
  legalAcceptanceRequired: boolean;
};

function SecurityCenter() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch("/api/saas/session", { credentials: "include" }).then(async (response) => {
      if (response.status === 401) { window.location.replace("/saas/login"); return; }
      if (!response.ok) { setError("无法读取当前会话"); return; }
      setSession(await response.json() as Session);
    }).catch(() => setError("无法连接服务器"));
  }, []);
  if (!session) return <main className="grid min-h-dvh place-items-center bg-bg text-sm text-muted">{error || "正在读取账户安全状态…"}</main>;
  return <SaasShell tenant={session.tenant}><div className="space-y-5"><header><p className="text-xs text-muted">独立安全入口</p><h1 className="mt-2 text-2xl font-semibold">账户安全中心</h1><p className="mt-2 text-sm text-muted">即使租户暂停或法律文件等待重新同意，你仍可检查设备、撤销会话和保护 MFA。</p></header>{session.legalAcceptanceRequired ? <div className="rounded-xl border border-warn/30 bg-warn/5 p-4 text-sm text-warn">当前法律文件尚未重新同意；安全中心保持可用，普通服务 API 仍受限。</div> : null}{!session.user.mfaEnabled ? <section className="rounded-xl border border-border bg-surface p-5"><h2 className="font-medium">启用多因素认证</h2><p className="mt-2 text-sm text-muted">Owner/Admin 必须在商业开放前启用 TOTP。启用操作不以接受新版条款为条件。</p><SaasMfaDialog /></section> : null}<SaasSessionSecurity mfaEnabled={session.user.mfaEnabled} /></div></SaasShell>;
}
