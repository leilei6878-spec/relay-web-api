import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { LegalPublicMetadata } from "@/lib/legal-content";

export const Route = createFileRoute("/saas/invite")({ component: AcceptInvite });

function AcceptInvite() {
  const [name, setName] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [done, setDone] = useState(false);
  const [legal, setLegal] = useState<LegalPublicMetadata | null>(null); const [legalAccepted, setLegalAccepted] = useState(false);
  useEffect(() => { void fetch("/api/saas/legal", { credentials: "omit" }).then(async (response) => { if (response.ok) setLegal(await response.json() as LegalPublicMetadata); }).catch(() => undefined); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!legal?.configured || !legal.approved || !legalAccepted) { setError("必须明确同意已批准的当前法律文件"); return; }
    const token = new URLSearchParams(window.location.search).get("token") || "";
    const response = await fetch("/api/saas/invite", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, name, password, legalAccepted, termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion, legalBundleSha256: legal.bundleSha256 }) });
    const body = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !body.ok) { setError(body.error || "邀请接受失败"); return; }
    setDone(true);
  }
  return <main className="grid min-h-dvh place-items-center bg-bg px-4 text-fg"><section className="w-full max-w-sm rounded-2xl border border-border bg-surface p-7">{done ? <><h1 className="text-xl font-medium">邀请已接受</h1><p className="mt-2 text-sm text-muted">现在可以使用受邀邮箱和密码登录。</p><Button asChild className="mt-6 w-full"><Link to="/saas/login">前往登录</Link></Button></> : <><h1 className="text-xl font-medium">加入企业租户</h1><p className="mt-2 text-sm text-muted">邀请链接同时验证你的邮箱。</p><form onSubmit={submit} className="mt-6 space-y-4"><Field label="姓名"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="设置密码"><Input type="password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required /></Field><label className="flex items-start gap-2 rounded-lg border border-border bg-elevated p-3 text-xs leading-5 text-muted"><input className="mt-1" type="checkbox" checked={legalAccepted} onChange={(event) => setLegalAccepted(event.target.checked)} required /><span>我已阅读并同意 <a className="underline" href="/legal/terms" target="_blank" rel="noreferrer">条款 {legal?.termsVersion || "未配置"}</a> 和 <a className="underline" href="/legal/privacy" target="_blank" rel="noreferrer">隐私政策 {legal?.privacyVersion || "未配置"}</a>。</span></label>{error ? <p className="text-sm text-danger">{error}</p> : null}<Button type="submit" className="w-full" disabled={!legal?.configured || !legal.approved || !legalAccepted}>{legal?.configured && legal.approved ? legalAccepted ? "接受邀请" : "请先明确同意法律文件" : "等待法律文件批准"}</Button></form></>}</section></main>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-2"><Label>{label}</Label>{children}</div>; }
