import { useState } from "react";
import { toast } from "sonner";
import { saasMutationHeaders } from "@/components/saas-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

export function SaasMfaDialog({ mfaEnabled = false }: { mfaEnabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  async function start() {
    const response = await fetch("/api/saas/session", { method: "POST", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ action: "mfa-start" }) });
    const body = await response.json() as { secret?: string; error?: string; replacingExisting?: boolean };
    if (!response.ok || !body.secret) { toast.error(body.error || "无法开始 MFA"); return; }
    setSecret(body.secret);
  }
  async function confirm() {
    const response = await fetch("/api/saas/session", { method: "POST", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ action: "mfa-confirm", code }) });
    const body = await response.json() as { ok?: boolean; recoveryCodes?: string[]; error?: string };
    if (!response.ok || !body.ok) { toast.error(body.error || "验证码错误"); return; }
    setRecovery(body.recoveryCodes || []); toast.success(mfaEnabled ? "新验证器已启用，其他会话已撤销" : "MFA 已启用");
  }
  return <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) { setSecret(""); setCode(""); setRecovery([]); } }}><DialogTrigger asChild><Button className="mt-4" variant="secondary">{mfaEnabled ? "更换验证器" : "配置 MFA"}</Button></DialogTrigger><DialogContent title="TOTP 多因素认证">{recovery.length ? <div><p className="text-sm text-warn">请离线保存以下恢复码，每个恢复码只能使用一次。</p><pre className="mt-3 rounded-md bg-elevated p-3 text-xs">{recovery.join("\n")}</pre><Button className="mt-4 w-full" onClick={() => window.location.reload()}>已安全保存，刷新会话状态</Button></div> : secret ? <div className="space-y-3">{mfaEnabled ? <p className="rounded-lg border border-warn/30 bg-warn/5 p-3 text-xs text-warn">旧验证器会继续有效，直到新验证码确认成功。确认后其他会话和旧恢复码会失效。</p> : null}<p className="text-sm text-muted">在身份验证器中手动添加密钥（10 分钟内确认）：</p><p className="break-all rounded-md bg-elevated p-3 font-mono text-xs">{secret}</p><div className="space-y-2"><Label>新验证器当前 6 位验证码</Label><Input inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></div><Button className="w-full" onClick={() => void confirm()}>验证并原子切换</Button></div> : <div><p className="text-sm text-muted">{mfaEnabled ? "新 Secret 会先暂存，未确认前不会关闭当前 MFA。更换操作要求当前会话最近通过 MFA。" : "启用后登录必须同时输入密码和身份验证器验证码。"}</p><Button className="mt-4 w-full" onClick={() => void start()}>{mfaEnabled ? "开始安全更换" : "生成 TOTP 密钥"}</Button></div>}</DialogContent></Dialog>;
}
