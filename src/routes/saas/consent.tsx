import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { saasMutationHeaders } from "@/components/saas-shell";
import { Button } from "@/components/ui/button";
import type { LegalPublicMetadata } from "@/lib/legal-content";

export const Route = createFileRoute("/saas/consent")({ component: LegalConsent });

function LegalConsent() {
  const [legal, setLegal] = useState<LegalPublicMetadata | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([
      fetch("/api/saas/session", { credentials: "include" }),
      fetch("/api/saas/legal", { credentials: "omit" }),
    ]).then(async ([sessionResponse, legalResponse]) => {
      if (sessionResponse.status === 401) { window.location.replace("/saas/login"); return; }
      const session = await sessionResponse.json() as { legalAcceptanceRequired?: boolean };
      if (!session.legalAcceptanceRequired) { window.location.replace("/portal"); return; }
      if (legalResponse.ok) setLegal(await legalResponse.json() as LegalPublicMetadata);
    }).catch(() => setError("无法读取当前法律文件"));
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!accepted || !legal?.configured || !legal.approved) { setError("必须明确同意已批准的当前法律文件"); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/saas/consent", {
        method: "POST", credentials: "include", headers: saasMutationHeaders(),
        body: JSON.stringify({ accepted, termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion, bundleSha256: legal.bundleSha256 }),
      });
      const body = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) { setError(body.error || "同意记录失败"); return; }
      window.location.replace("/portal");
    } catch { setError("无法连接服务器"); } finally { setBusy(false); }
  }
  return <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10 text-fg"><section className="w-full max-w-lg rounded-2xl border border-border bg-surface p-7"><p className="text-xs text-warn">法律文件已更新</p><h1 className="mt-2 text-2xl font-semibold">继续使用前请重新确认</h1><p className="mt-2 text-sm text-muted">当前租户会话和付费 API Key 会保持受限，直到具备权限的成员接受当前文件。</p>{legal ? <div className="mt-5 rounded-lg border border-border bg-elevated p-4 text-sm text-muted"><p>运营主体：{legal.operatorName || "未配置"}</p><p>条款 {legal.termsVersion || "—"} · 隐私 {legal.privacyVersion || "—"} · {legal.effectiveDate || "—"}</p><p className="mt-2 break-all font-mono text-[10px] text-subtle">SHA-256 {legal.bundleSha256}</p></div> : <p className="mt-5 text-sm text-muted">正在读取…</p>}<form className="mt-5 space-y-4" onSubmit={submit}><label className="flex items-start gap-2 rounded-lg border border-border p-3 text-xs leading-5 text-muted"><input className="mt-1" type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} required /><span>我已阅读并明确同意 <a className="underline" href="/legal/terms" target="_blank" rel="noreferrer">当前服务条款</a> 与 <a className="underline" href="/legal/privacy" target="_blank" rel="noreferrer">当前隐私政策</a>。</span></label>{error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}<Button className="w-full" type="submit" disabled={busy || !accepted || !legal?.configured || !legal.approved}>{busy ? "正在记录…" : accepted ? "记录同意并继续" : "请先明确同意"}</Button></form><p className="mt-4 text-center text-xs text-muted">不同意新版文件也可以继续使用 <a className="underline" href="/saas/privacy-center">数据导出与租户关停</a>。</p></section></main>;
}
