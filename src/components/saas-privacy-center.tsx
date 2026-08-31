import { Download, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { saasMutationHeaders } from "@/components/saas-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

export type PrivacyRequest = {
  id: string; kind: string; status: string; dueAt: string | null; requestedAt: string | null;
  cancelledAt: string | null; completedAt: string | null; blockedReason: string | null; snapshotSha256: string | null;
};

function date(value: unknown) {
  if (!value) return "—";
  return new Date(String(value)).toLocaleString("zh-CN", { hour12: false });
}

export function PrivacyCenter({ tenantName, requests, reload }: { tenantName: string; requests: PrivacyRequest[]; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const activeClosure = requests.find((item) => item.kind === "tenant_closure" && ["requested", "blocked"].includes(item.status));
  async function download() {
    const response = await fetch("/api/saas/privacy", { method: "POST", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ action: "export" }) });
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; toast.error(body.error || "数据导出失败"); return; }
    const blob = await response.blob();
    const filename = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") || "")?.[1] || "relay-tenant-export.json";
    const href = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = href; anchor.download = filename; anchor.click(); URL.revokeObjectURL(href);
    toast.success(`数据档案已生成 · SHA-256 ${(response.headers.get("x-relay-export-sha256") || "").slice(0, 12)}…`); await reload();
  }
  async function requestClosure() {
    const response = await fetch("/api/saas/privacy", { method: "POST", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ action: "request-closure", confirmTenantName: confirmation }) });
    const body = await response.json() as { error?: string };
    if (!response.ok) { toast.error(body.error || "关停申请失败"); return; }
    setOpen(false); setConfirmation(""); toast.success("关停申请已进入可撤销冷静期"); await reload();
  }
  async function cancelClosure() {
    if (!activeClosure) return;
    const response = await fetch("/api/saas/privacy", { method: "POST", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ action: "cancel-closure", requestId: activeClosure.id }) });
    const body = await response.json() as { error?: string };
    if (!response.ok) { toast.error(body.error || "撤销失败"); return; }
    toast.success("关停申请已撤销"); await reload();
  }
  return <section id="privacy" className="rounded-xl border border-border bg-surface"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4"><div><h2 className="font-medium">数据权利与租户关停</h2><p className="mt-1 text-xs text-subtle">仅 Owner 可操作；下载与关停均强制使用最近验证的 MFA 会话。</p></div><Button size="sm" variant="secondary" onClick={() => void download()}><Download className="size-3.5" />下载完整数据档案</Button></div><div className="space-y-4 p-5"><p className="text-sm text-muted">导出包含成员、密钥元数据、订单、资金流水、用量、法律接受与审计记录，不包含密码、令牌、MFA Secret、网络 HMAC 或支付机密。</p>{activeClosure ? <div className="rounded-lg border border-warn/30 bg-warn/5 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium text-warn">关停申请：{activeClosure.status}</p><p className="mt-1 text-xs text-muted">计划执行 {date(activeClosure.dueAt)}{activeClosure.blockedReason ? ` · 阻塞：${activeClosure.blockedReason}` : ""}</p></div><Button size="sm" variant="secondary" onClick={() => void cancelClosure()}>撤销申请</Button></div></div> : <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button size="sm" variant="destructive"><Trash2 className="size-3.5" />申请关停租户</Button></DialogTrigger><DialogContent title="申请关停租户"><div className="space-y-3"><p className="text-sm text-muted">申请进入可撤销冷静期。余额、包含额度、预授权、未完成退款或拒付未清零时，到期执行会保持阻塞；账务、法律接受与安全审计按法定期限继续保留。</p><div className="space-y-2"><Label>{`输入租户名称“${tenantName}”确认`}</Label><Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div><Button className="w-full" variant="destructive" disabled={confirmation !== tenantName} onClick={() => void requestClosure()}>确认申请关停</Button></div></DialogContent></Dialog>}</div></section>;
}
