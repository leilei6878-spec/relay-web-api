import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export const Route = createFileRoute("/saas/invite")({ component: AcceptInvite });

function AcceptInvite() {
  const [name, setName] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [done, setDone] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    const token = new URLSearchParams(window.location.search).get("token") || "";
    const response = await fetch("/api/saas/invite", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, name, password }) });
    const body = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !body.ok) { setError(body.error || "邀请接受失败"); return; }
    setDone(true);
  }
  return <main className="grid min-h-dvh place-items-center bg-bg px-4 text-fg"><section className="w-full max-w-sm rounded-2xl border border-border bg-surface p-7">{done ? <><h1 className="text-xl font-medium">邀请已接受</h1><p className="mt-2 text-sm text-muted">现在可以使用受邀邮箱和密码登录。</p><Button asChild className="mt-6 w-full"><Link to="/saas/login">前往登录</Link></Button></> : <><h1 className="text-xl font-medium">加入企业租户</h1><p className="mt-2 text-sm text-muted">邀请链接同时验证你的邮箱。</p><form onSubmit={submit} className="mt-6 space-y-4"><Field label="姓名"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="设置密码"><Input type="password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required /></Field>{error ? <p className="text-sm text-danger">{error}</p> : null}<Button type="submit" className="w-full">接受邀请</Button></form></>}</section></main>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-2"><Label>{label}</Label>{children}</div>; }
