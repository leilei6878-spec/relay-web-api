import { createFileRoute } from "@tanstack/react-router";
import { Activity, Building2, LockKeyhole } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export const Route = createFileRoute("/saas/login")({ component: SaasLogin });

function SaasLogin() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [tenantName, setTenantName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void fetch("/api/saas/session", { credentials: "include" }).then((response) => {
      if (response.ok) window.location.replace("/portal");
    }).catch(() => undefined);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/saas/session", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, tenantName, ownerName, email, password,
          totp: /^\d{6}$/.test(totp.trim()) ? totp.trim() : undefined,
          recoveryCode: totp.trim() && !/^\d{6}$/.test(totp.trim()) ? totp.trim() : undefined }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; verificationRequired?: boolean };
      if (!response.ok || !body.ok) {
        if (body.error === "MFA_REQUIRED") setError("请输入身份验证器中的 6 位验证码或一个未使用的恢复码");
        else if (body.error === "REGISTRATION_DISABLED") setError("公开注册尚未开放，请联系销售开通租户");
        else setError(body.error || "操作失败");
        return;
      }
      if (body.verificationRequired) {
        setNotice("注册成功。验证链接已发送到你的邮箱，验证后即可登录。");
        setMode("login");
        setPassword("");
        return;
      }
      window.location.replace("/portal");
    } catch {
      setError("无法连接服务器");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!email) { setError("请先填写注册邮箱"); return; }
    const response = await fetch("/api/saas/session", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resend-verification", email }) });
    const body = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !body.ok) { setError(body.error || "发送失败"); return; }
    setNotice("如果该邮箱有待验证账户，验证邮件已重新发送。");
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10 text-fg">
      <section className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-2xl shadow-black/30 sm:p-8">
        <div className="flex items-center gap-3"><span className="grid size-11 place-items-center rounded-xl border border-border bg-elevated"><Activity className="size-5" /></span><div><p className="font-medium">Relay SaaS</p><p className="text-xs text-subtle">官方 AI API 商业网关</p></div></div>
        <div className="mt-8 flex rounded-lg border border-border bg-elevated p-1">
          <button className={`flex-1 rounded-md px-3 py-2 text-sm ${mode === "login" ? "bg-surface text-fg" : "text-muted"}`} onClick={() => setMode("login")}>登录</button>
          <button className={`flex-1 rounded-md px-3 py-2 text-sm ${mode === "register" ? "bg-surface text-fg" : "text-muted"}`} onClick={() => setMode("register")}>企业注册</button>
        </div>
        <div className="mt-6"><div className="mb-3 grid size-9 place-items-center rounded-lg bg-elevated text-muted">{mode === "login" ? <LockKeyhole className="size-4" /> : <Building2 className="size-4" />}</div><h1 className="text-xl font-semibold">{mode === "login" ? "登录客户控制台" : "创建企业租户"}</h1><p className="mt-1.5 text-sm text-muted">付费 API 只通过官方供应商接口处理。</p></div>
        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === "register" ? <><Field label="企业名称"><Input value={tenantName} onChange={(event) => setTenantName(event.target.value)} required /></Field><Field label="联系人"><Input value={ownerName} onChange={(event) => setOwnerName(event.target.value)} required /></Field></> : null}
          <Field label="邮箱"><Input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></Field>
          <Field label="密码"><Input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={10} /></Field>
          {mode === "login" ? <Field label="MFA 验证码或恢复码（启用后必填）"><Input autoComplete="one-time-code" maxLength={64} value={totp} onChange={(event) => setTotp(event.target.value.trim())} /></Field> : null}
          {error ? <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-sm text-danger">{error}</p> : null}
          {notice ? <p className="rounded-lg border border-ok/30 bg-ok/5 px-3 py-2.5 text-sm text-ok">{notice}</p> : null}
          <Button type="submit" className="w-full" disabled={busy}>{busy ? "请稍候…" : mode === "login" ? "登录" : "创建租户"}</Button>
          {mode === "login" ? <a href="/saas/reset" className="block text-center text-xs text-muted underline">忘记密码</a> : null}
          {mode === "login" ? <button type="button" className="block w-full text-center text-xs text-muted underline" onClick={() => void resend()}>重新发送验证邮件</button> : null}
        </form>
        <p className="mt-6 text-center text-[11px] leading-5 text-subtle">注册即表示同意 <a className="underline" href="/legal/terms">服务条款</a> 与 <a className="underline" href="/legal/privacy">隐私政策</a>。</p>
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>;
}
