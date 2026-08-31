import { Laptop, RefreshCw, ShieldCheck, Smartphone, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { saasMutationHeaders } from "@/components/saas-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

type SessionRow = {
  id: string; tenantId: string; tenantName: string; tenantStatus: string; ipAddress: string; userAgent: string;
  createdAt: string | null; lastSeenAt: string | null; expiresAt: string | null; mfaVerifiedAt: string | null;
  revokedAt: string | null; revokedReason: string | null; current: boolean; active: boolean;
};

function date(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function device(userAgent: string) {
  const mobile = /Android|iPhone|iPad|Mobile/i.test(userAgent);
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Chrome\//.test(userAgent) ? "Chrome" : /Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : "浏览器";
  const os = /Windows/i.test(userAgent) ? "Windows" : /Android/i.test(userAgent) ? "Android" : /iPhone|iPad/i.test(userAgent) ? "iOS" : /Mac OS/i.test(userAgent) ? "macOS" : /Linux/i.test(userAgent) ? "Linux" : "未知系统";
  return { mobile, label: `${browser} · ${os}` };
}

export function SaasSessionSecurity({ mfaEnabled }: { mfaEnabled: boolean }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/saas/security", { credentials: "include" });
    const body = await response.json() as { sessions?: SessionRow[]; error?: string };
    if (!response.ok) { toast.error(body.error || "无法读取活跃会话"); setLoading(false); return; }
    setSessions(body.sessions || []); setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function mutate(body: Record<string, unknown>) {
    const response = await fetch("/api/saas/security", { method: "POST", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify(body) });
    const result = await response.json() as { ok?: boolean; error?: string; recoveryCodes?: string[]; result?: { revoked?: number } };
    if (!response.ok || !result.ok) throw new Error(result.error || "安全操作失败");
    return result;
  }
  async function revoke(id: string) {
    try { await mutate({ action: "revoke-session", sessionId: id }); toast.success("设备会话已撤销"); await load(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "撤销失败"); }
  }
  async function revokeOthers() {
    try { const result = await mutate({ action: "revoke-other-sessions" }); toast.success(`已撤销 ${result.result?.revoked || 0} 个其他会话`); await load(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "撤销失败"); }
  }
  async function rotateRecovery() {
    try { const result = await mutate({ action: "rotate-recovery-codes" }); setRecoveryCodes(result.recoveryCodes || []); toast.success("恢复码已轮换，其他会话已撤销"); await load(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "恢复码轮换失败"); }
  }
  const activeOthers = sessions.filter((row) => row.active && !row.current).length;
  return <section className="rounded-xl border border-border bg-surface"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4"><div><div className="flex items-center gap-2"><ShieldCheck className="size-4" /><h2 className="font-medium">登录设备与恢复</h2></div><p className="mt-1 text-xs text-subtle">最近活动最多每五分钟刷新；IP 与设备信息仅对当前用户可见。</p></div><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw className="size-3.5" />刷新</Button><Button size="sm" variant="secondary" onClick={() => void revokeOthers()} disabled={!activeOthers}>撤销其他会话 ({activeOthers})</Button><Dialog open={recoveryOpen} onOpenChange={(open) => { setRecoveryOpen(open); if (!open) setRecoveryCodes([]); }}><DialogTrigger asChild><Button size="sm" variant="secondary" disabled={!mfaEnabled}>轮换恢复码</Button></DialogTrigger><DialogContent title="轮换 MFA 恢复码">{recoveryCodes.length ? <div><p className="text-sm text-warn">旧恢复码已全部失效。请离线保存新恢复码；关闭后不再显示。</p><pre className="mt-3 rounded-md bg-elevated p-3 text-xs">{recoveryCodes.join("\n")}</pre><Button className="mt-4 w-full" onClick={() => setRecoveryOpen(false)}>我已安全保存</Button></div> : <div><p className="text-sm text-muted">该操作要求当前会话最近通过 MFA，并会撤销此设备之外的全部登录会话。</p><Button className="mt-4 w-full" onClick={() => void rotateRecovery()}>生成新的恢复码</Button></div>}</DialogContent></Dialog></div></div><div className="divide-y divide-border">{sessions.slice(0, 30).map((row) => { const info = device(row.userAgent); const Icon = info.mobile ? Smartphone : Laptop; return <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"><div className="flex min-w-0 items-start gap-3"><span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-elevated"><Icon className="size-4" /></span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{info.label}</p>{row.current ? <Badge tone="ok">当前设备</Badge> : null}<Badge tone={row.active ? "info" : "default"}>{row.active ? "活跃" : row.revokedAt ? "已撤销" : "已过期"}</Badge></div><p className="mt-1 text-xs text-muted">{row.ipAddress} · {row.tenantName} ({row.tenantStatus})</p><p className="mt-1 text-[11px] text-subtle">最近 {date(row.lastSeenAt)} · 登录 {date(row.createdAt)} · 到期 {date(row.expiresAt)}{row.mfaVerifiedAt ? ` · MFA ${date(row.mfaVerifiedAt)}` : ""}{row.revokedReason ? ` · ${row.revokedReason}` : ""}</p></div></div>{row.active && !row.current ? <Button size="sm" variant="ghost" onClick={() => void revoke(row.id)}><XCircle className="size-3.5" />撤销</Button> : null}</div>; })}{!sessions.length && !loading ? <p className="px-5 py-8 text-center text-sm text-subtle">没有可显示的会话</p> : null}{loading ? <p className="px-5 py-8 text-center text-sm text-subtle">正在读取会话…</p> : null}</div></section>;
}
