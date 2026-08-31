import { Link } from "@tanstack/react-router";
import { Activity, CreditCard, Download, KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

function csrfCookie() {
  if (typeof document === "undefined") return "";
  const part = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("relay_saas_csrf="));
  return part ? decodeURIComponent(part.split("=").slice(1).join("=")) : "";
}

export function saasMutationHeaders() {
  return { "Content-Type": "application/json", "X-CSRF-Token": csrfCookie() };
}

export async function saasLogout() {
  await fetch("/api/saas/session", { method: "DELETE", credentials: "include", headers: saasMutationHeaders() });
  window.location.replace("/saas/login");
}

export function SaasShell({
  children,
  tenant,
}: {
  children: ReactNode;
  tenant?: { id?: string; name: string; status?: string; role: string } | null;
}) {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/portal" className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-lg border border-border bg-elevated"><Activity className="size-4" /></span>
            <div><p className="text-sm font-medium">Relay SaaS</p><p className="text-[11px] text-subtle">Official AI API Gateway</p></div>
          </Link>
          <nav className="flex items-center gap-1 text-xs text-muted">
            <a href="/portal#overview" className="rounded px-3 py-2 hover:bg-elevated"><CreditCard className="mr-1 inline size-3.5" />账务</a>
            <a href="/portal#keys" className="rounded px-3 py-2 hover:bg-elevated"><KeyRound className="mr-1 inline size-3.5" />密钥</a>
            <a href="/saas/security-center" className="rounded px-3 py-2 hover:bg-elevated"><ShieldCheck className="mr-1 inline size-3.5" />安全</a>
            <a href="/saas/privacy-center" className="rounded px-3 py-2 hover:bg-elevated"><Download className="mr-1 inline size-3.5" />数据权利</a>
          </nav>
          <div className="flex items-center gap-3">
            {tenant ? <TenantSwitcher tenant={tenant} /> : null}
            <Button variant="ghost" size="sm" onClick={() => void saasLogout()}><LogOut className="size-3.5" />退出</Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

type TenantChoice = { id: string; name: string; status: string; role: string };

function TenantSwitcher({ tenant }: { tenant: { id?: string; name: string; status?: string; role: string } }) {
  const [choices, setChoices] = useState<TenantChoice[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!tenant.id) return;
    void fetch("/api/saas/tenants", { credentials: "include" }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { tenants?: TenantChoice[] };
      setChoices(body.tenants || []);
    }).catch(() => undefined);
  }, [tenant.id]);
  async function change(tenantId: string) {
    if (!tenantId || tenantId === tenant.id) return;
    setBusy(true);
    try {
      const response = await fetch("/api/saas/tenants", {
        method: "POST", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ tenantId }),
      });
      const body = await response.json() as { tenant?: TenantChoice; legalAcceptanceRequired?: boolean; error?: string };
      if (!response.ok || !body.tenant) throw new Error(body.error || "TENANT_SWITCH_FAILED");
      window.location.replace(body.tenant.status === "suspended" ? "/saas/privacy-center" : body.legalAcceptanceRequired ? "/saas/consent" : "/portal");
    } catch (error) { toast.error(error instanceof Error ? error.message : "租户切换失败"); setBusy(false); }
  }
  if (choices.length > 1 && tenant.id) return <div className="text-right"><select aria-label="当前租户" className="h-9 max-w-56 rounded-md border border-border bg-elevated px-2 text-xs" value={tenant.id} disabled={busy} onChange={(event) => void change(event.target.value)}>{choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name} · {choice.role} · {choice.status}</option>)}</select></div>;
  return <div className="text-right"><p className="text-xs font-medium">{tenant.name}</p><p className="text-[11px] text-subtle">{tenant.role}</p></div>;
}
