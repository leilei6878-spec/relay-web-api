import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LEGAL_PRIVACY_SECTIONS, type LegalPublicMetadata } from "@/lib/legal-content";

export const Route = createFileRoute("/legal/privacy")({ component: Privacy });

function Privacy() {
  const [legal, setLegal] = useState<LegalPublicMetadata | null>(null);
  useEffect(() => { void fetch("/api/saas/legal", { credentials: "omit" }).then(async (response) => { if (response.ok) setLegal(await response.json() as LegalPublicMetadata); }).catch(() => undefined); }, []);
  const accepted = legal?.configured && legal.approved;
  return <main className="min-h-dvh bg-bg px-4 py-10 text-fg"><article className="mx-auto max-w-3xl rounded-2xl border border-border bg-surface p-6 text-sm leading-7 text-muted sm:p-10"><Link to="/saas/login" className="text-xs underline">返回登录</Link><h1 className="mt-5 text-2xl font-semibold text-fg">Relay SaaS 隐私政策</h1><p className={`mt-2 text-xs ${accepted ? "text-ok" : "text-warn"}`}>状态：{accepted ? `已配置版本 ${legal.privacyVersion}` : "上线前审阅稿，尚未通过法务门禁"}{legal?.effectiveDate ? ` · 生效日 ${legal.effectiveDate}` : ""}</p>{legal?.operatorName ? <p className="mt-1 text-xs text-subtle">数据控制者：{legal.operatorName} · 联系：{legal.contactEmail}</p> : <p className="mt-1 text-xs text-warn">正式收费前须确认控制者身份、联系地址、适用地区与跨境传输条款。</p>}<div className="mt-8 space-y-5 [&_h2]:pt-3 [&_h2]:text-base [&_h2]:font-medium [&_h2]:text-fg">{LEGAL_PRIVACY_SECTIONS.map(([heading, content]) => <section key={heading}><h2>{heading}</h2><p>{content}</p></section>)}</div>{legal?.bundleSha256 ? <p className="mt-8 break-all border-t border-border pt-4 font-mono text-[10px] text-subtle">内容包 SHA-256：{legal.bundleSha256}</p> : null}</article></main>;
}
