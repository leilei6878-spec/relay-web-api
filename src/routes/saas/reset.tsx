import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export const Route = createFileRoute("/saas/reset")({ component: ResetPassword });

function ResetPassword() {
  const token = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("token") || "";
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); setError(""); const response = await fetch("/api/saas/session", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(token ? { action: "password-reset", token, password } : { action: "password-reset-request", email }) }); const body = await response.json() as { ok?: boolean; error?: string }; if (!response.ok || !body.ok) { setError(body.error || "操作失败"); return; } setMessage(token ? "密码已重置，请重新登录。" : "如果该邮箱存在，重置链接已发送。"); }
  return <main className="grid min-h-dvh place-items-center bg-bg px-4 text-fg"><section className="w-full max-w-sm rounded-2xl border border-border bg-surface p-7"><h1 className="text-xl font-medium">{token ? "设置新密码" : "找回密码"}</h1><p className="mt-2 text-sm text-muted">{token ? "重置后所有现有登录会话都会失效。" : "为保护隐私，无论邮箱是否存在都返回相同结果。"}</p><form onSubmit={submit} className="mt-6 space-y-4">{token ? <Field label="新密码"><Input type="password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required /></Field> : <Field label="企业邮箱"><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></Field>}{message ? <p className="text-sm text-ok">{message}</p> : null}{error ? <p className="text-sm text-danger">{error}</p> : null}<Button className="w-full" type="submit">{token ? "重置密码" : "发送重置链接"}</Button></form><Button asChild variant="ghost" className="mt-3 w-full"><Link to="/saas/login">返回登录</Link></Button></section></main>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-2"><Label>{label}</Label>{children}</div>; }
