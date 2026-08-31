import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { PrivacyCenter, type PrivacyRequest } from "@/components/saas-privacy-center";
import { SaasMfaDialog } from "@/components/saas-mfa-dialog";
import { SaasShell } from "@/components/saas-shell";

export const Route = createFileRoute("/saas/privacy-center")({ component: TenantPrivacyCenter });

type Session = {
  user: { mfaEnabled: boolean };
  tenant: { id: string; name: string; status: string; role: string };
  legalAcceptanceRequired: boolean;
};

function TenantPrivacyCenter() {
  const [session, setSession] = useState<Session | null>(null);
  const [requests, setRequests] = useState<PrivacyRequest[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const sessionResponse = await fetch("/api/saas/session", { credentials: "include" });
    if (sessionResponse.status === 401) { window.location.replace("/saas/login"); return; }
    const current = await sessionResponse.json() as Session;
    setSession(current);
    if (current.tenant.role !== "owner") { setError("只有租户 Owner 可以管理组织数据导出与关停"); return; }
    const response = await fetch("/api/saas/privacy", { credentials: "include" });
    const body = await response.json() as { requests?: PrivacyRequest[]; error?: string };
    if (!response.ok) { setError(body.error || "无法读取数据权利请求"); return; }
    setRequests(body.requests || []); setError("");
  }, []);
  useEffect(() => { void load().catch(() => setError("无法连接服务器")); }, [load]);
  if (!session) return <main className="grid min-h-dvh place-items-center bg-bg text-sm text-muted">正在读取数据权利中心…</main>;
  return <SaasShell tenant={session.tenant}><div className="space-y-5"><header><p className="text-xs text-muted">无需接受新版条款即可使用</p><h1 className="mt-2 text-2xl font-semibold">数据权利中心</h1><p className="mt-2 text-sm text-muted">这里独立于继续使用服务的法律同意门禁；身份、租户角色和高风险操作验证仍然生效。</p></header>{session.legalAcceptanceRequired ? <div className="rounded-xl border border-warn/30 bg-warn/5 p-4 text-sm text-warn">当前法律文件尚未重新同意。你仍可导出或申请关停；如需继续使用付费服务，请前往 <a className="underline" href="/saas/consent">重新同意页面</a>。</div> : null}{!session.user.mfaEnabled ? <section className="rounded-xl border border-border bg-surface p-5"><h2 className="font-medium">先完成安全验证</h2><p className="mt-2 text-sm text-muted">数据导出和租户关停包含敏感企业信息，必须先启用 TOTP MFA。此安全操作不要求接受新版条款。</p><SaasMfaDialog /></section> : null}{error ? <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">{error}</p> : session.tenant.role === "owner" ? <PrivacyCenter tenantName={session.tenant.name} requests={requests} reload={load} /> : null}</div></SaasShell>;
}
