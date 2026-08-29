import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/legal/privacy")({ component: Privacy });

function Privacy() {
  return <main className="min-h-dvh bg-bg px-4 py-10 text-fg"><article className="mx-auto max-w-3xl rounded-2xl border border-border bg-surface p-6 text-sm leading-7 text-muted sm:p-10"><Link to="/saas/login" className="text-xs underline">返回登录</Link><h1 className="mt-5 text-2xl font-semibold text-fg">Relay SaaS 隐私政策（上线前审阅稿）</h1><p className="mt-2 text-xs text-warn">正式收费前须由运营主体和律师确认控制者身份、联系地址、适用地区与跨境传输条款。</p><div className="mt-8 space-y-5 [&_h2]:pt-3 [&_h2]:text-base [&_h2]:font-medium [&_h2]:text-fg">
    <h2>收集的数据</h2><p>企业名称、联系人、邮箱、登录与 MFA 状态、IP/设备信息、API 密钥哈希、请求元数据、供应商用量、订单和账务流水。完整客户 API 密钥只显示一次，服务器只保存哈希。</p>
    <h2>处理目的</h2><p>用于身份验证、租户隔离、提供官方 AI API、计量计费、反滥用、故障排查、客户支持和履行法律义务。</p>
    <h2>第三方处理方</h2><p>请求内容会按客户选择发送至 OpenAI、Google 或 Leonardo 的官方商业接口。各供应商按其商业条款与隐私政策处理数据。平台不会把商业客户请求发送到内部网页账号池。</p>
    <h2>保留期限</h2><p>请求内容默认 30 天后脱敏；失效 Session 默认保留 30 天；运营检查默认 90 天；商业审计默认 365 天；账务流水默认保留 7 年或法律要求的更长期限。对象存储采用相匹配的生命周期规则。</p>
    <h2>安全</h2><p>采用 HTTPS、HttpOnly Session、CSRF/Origin 校验、角色权限、TOTP MFA、租户级哈希密钥、加密密钥存储、追加式账本、告警和异地备份。</p>
    <h2>数据主体权利</h2><p>客户可请求访问、更正、导出或删除适用数据。依法必须保存的财务、风控和安全记录可能不被立即删除。</p>
  </div></article></main>;
}
