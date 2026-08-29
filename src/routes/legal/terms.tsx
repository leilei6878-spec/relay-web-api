import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/legal/terms")({ component: Terms });

function Terms() {
  return <Legal title="Relay SaaS 服务条款（上线前审阅稿）">
    <p>本页是产品执行规则的公开草案，不替代适用法下的强制权利。正式收费仅在运营主体完成律师审阅并设置商业法律批准门禁后开启。</p>
    <h2>1. 服务</h2><p>Relay 提供基于官方授权 API 的统一接口、用量计量、密钥和账单管理。平台不承诺底层第三方 AI 服务持续可用，也不会将网页账号访问包装为付费官方 API。</p>
    <h2>2. 账户与安全</h2><p>客户须保护账户、MFA 和 API 密钥，不得转售密钥、绕过配额或从事违法、侵权、欺诈、骚扰、恶意软件、规避安全措施等活动。</p>
    <h2>3. 预付余额与订单</h2><p>余额以最小货币单位记账。每次请求先预授权，再以供应商返回的权威用量结算。人工充值订单只有管理员确认到账后入账。退款、发票和税务按最终销售合同与适用法律处理。</p>
    <h2>4. 内容与第三方供应商</h2><p>客户应拥有输入内容所需权利，并遵守所选官方供应商政策。模型输出可能不准确、不唯一，也可能受供应商内容过滤或区域限制。</p>
    <h2>5. 可用性</h2><p>试运营阶段不提供正式 SLA。正式 SLA、支持响应时间、赔偿上限和计划维护窗口将在商业合同中另行约定。</p>
    <h2>6. 暂停与终止</h2><p>欠费、滥用、安全事件、法律要求或上游供应商限制可能导致密钥或租户暂停。客户可请求导出或删除适用范围内的数据，但依法必须保留的账务流水除外。</p>
  </Legal>;
}

function Legal({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="min-h-dvh bg-bg px-4 py-10 text-fg"><article className="mx-auto max-w-3xl rounded-2xl border border-border bg-surface p-6 text-sm leading-7 text-muted sm:p-10"><Link to="/saas/login" className="text-xs underline">返回登录</Link><h1 className="mt-5 text-2xl font-semibold text-fg">{title}</h1><p className="mt-2 text-xs text-warn">状态：上线前审阅稿 · 2026-08-29</p><div className="mt-8 space-y-5 [&_h2]:pt-3 [&_h2]:text-base [&_h2]:font-medium [&_h2]:text-fg">{children}</div></article></main>;
}
