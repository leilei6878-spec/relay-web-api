import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Copy, CreditCard, KeyRound, Plus, ShieldCheck, WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SaasShell, saasMutationHeaders } from "@/components/saas-shell";
import { PrivacyCenter, type PrivacyRequest } from "@/components/saas-privacy-center";
import { SaasMfaDialog } from "@/components/saas-mfa-dialog";
import { SaasSessionSecurity } from "@/components/saas-session-security";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

export const Route = createFileRoute("/portal")({ component: Portal });

type SessionBody = {
  user: { id: string; email: string; name: string; mfaEnabled: boolean };
  tenant: { id: string; name: string; status: string; role: string };
  mfaVerified: boolean;
  legalAcceptanceRequired: boolean;
};

type BillingBody = {
  tenant: { balanceMinor: number; reservedMinor: number; includedBalanceMinor: number; includedReservedMinor: number; currency: string; planId: string; pendingPlanId: string | null; planChangeEffectiveAt: string | null; monthlyBudgetMinor: number };
  transactions: Record<string, unknown>[];
  charges: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  plans: Record<string, unknown>[];
  planPeriods: Record<string, unknown>[];
};

function money(value: unknown, currency = "USD") {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format(Number(value || 0) / 100);
}

function date(value: unknown) {
  if (!value) return "—";
  return new Date(String(value)).toLocaleString("zh-CN", { hour12: false });
}

function Portal() {
  const [session, setSession] = useState<SessionBody | null>(null);
  const [billing, setBilling] = useState<BillingBody | null>(null);
  const [keys, setKeys] = useState<Record<string, unknown>[]>([]);
  const [members, setMembers] = useState<Record<string, unknown>[]>([]);
  const [audits, setAudits] = useState<Record<string, unknown>[]>([]);
  const [privacyRequests, setPrivacyRequests] = useState<PrivacyRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const sessionResponse = await fetch("/api/saas/session", { credentials: "include" });
    if (sessionResponse.status === 401) {
      window.location.replace("/saas/login");
      return;
    }
    const sessionBody = await sessionResponse.json() as SessionBody;
    if (sessionBody.tenant.status === "suspended") {
      window.location.replace("/saas/privacy-center");
      return;
    }
    if (sessionBody.legalAcceptanceRequired) {
      window.location.replace("/saas/consent");
      return;
    }
    const [billingBody, keyBody, memberBody, auditBody, privacyBody] = await Promise.all([
      fetch("/api/saas/billing", { credentials: "include" }).then((response) => response.json() as Promise<BillingBody>),
      fetch("/api/saas/keys", { credentials: "include" }).then((response) => response.json() as Promise<{ keys?: Record<string, unknown>[] }>),
      fetch("/api/saas/members", { credentials: "include" }).then((response) => response.json() as Promise<{ members?: Record<string, unknown>[] }>),
      ["owner", "admin"].includes(sessionBody.tenant.role)
        ? fetch("/api/saas/audit?limit=100", { credentials: "include" }).then((response) => response.json() as Promise<{ events?: Record<string, unknown>[] }>)
        : Promise.resolve({ events: [] as Record<string, unknown>[] }),
      sessionBody.tenant.role === "owner"
        ? fetch("/api/saas/privacy", { credentials: "include" }).then((response) => response.json() as Promise<{ requests?: PrivacyRequest[] }>)
        : Promise.resolve({ requests: [] as PrivacyRequest[] }),
    ]);
    setSession(sessionBody);
    setBilling(billingBody);
    setKeys(keyBody.keys || []);
    setMembers(memberBody.members || []);
    setAudits(auditBody.events || []);
    setPrivacyRequests(privacyBody.requests || []);
    setLoading(false);
  }, []);

  useEffect(() => { void load().catch(() => setLoading(false)); }, [load]);

  if (loading || !session || !billing) return <main className="grid min-h-dvh place-items-center bg-bg text-sm text-muted">正在加载客户控制台…</main>;
  const terminalOperations = new Set(audits.filter((row) => row.outcome !== "started").map((row) => row.operation_id));
  const visibleAudits = audits.filter((row) => row.outcome !== "started" || !terminalOperations.has(row.operation_id));

  return (
    <SaasShell tenant={session.tenant}>
      <div className="space-y-8">
        <header><Badge tone="ok">{session.tenant.status}</Badge><h1 className="mt-3 text-3xl font-semibold tracking-tight">欢迎，{session.user.name}</h1><p className="mt-2 text-sm text-muted">所有付费请求均走官方供应商，并经过余额预授权与用量结算。</p></header>
        {["owner", "admin", "billing", "developer"].includes(session.tenant.role) && !session.mfaVerified ? <div className="rounded-xl border border-warn/30 bg-warn/5 p-4 text-sm text-warn">当前会话尚未通过 MFA。商业模式开启后，密钥、资金、套餐和成员变更将返回 <span className="font-mono">MFA_STEP_UP_REQUIRED</span>；请在本页“账户安全”中启用 MFA，或退出后使用验证码/恢复码重新登录。</div> : null}

        <section id="overview" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat icon={<WalletCards className="size-4" />} label="可用余额" value={money(billing.tenant.balanceMinor - billing.tenant.reservedMinor, billing.tenant.currency)} />
          <Stat icon={<CreditCard className="size-4" />} label="预授权中" value={money(billing.tenant.reservedMinor, billing.tenant.currency)} />
          <Stat icon={<WalletCards className="size-4" />} label="套餐额度" value={money(billing.tenant.includedBalanceMinor - billing.tenant.includedReservedMinor, billing.tenant.currency)} />
          <Stat icon={<CheckCircle2 className="size-4" />} label="当前套餐" value={billing.tenant.planId} />
          <Stat icon={<KeyRound className="size-4" />} label="有效密钥" value={String(keys.filter((key) => key.enabled && !key.revoked_at).length)} />
        </section>

        <section className="rounded-xl border border-border bg-surface">
          <div className="border-b border-border px-5 py-4"><h2 className="font-medium">套餐与下期变更</h2><p className="mt-1 text-xs text-subtle">月费从现金余额扣除；包含额度单独记账、不可退款并优先抵扣用量。变更在下一账期生效。</p></div>
          <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">{billing.plans.map((plan) => <div key={String(plan.id)} className="rounded-lg border border-border bg-elevated p-4"><div className="flex items-center justify-between"><p className="font-medium">{String(plan.name)}</p><Badge tone={plan.id === billing.tenant.planId ? "ok" : plan.id === billing.tenant.pendingPlanId ? "warn" : "default"}>{plan.id === billing.tenant.planId ? "当前" : plan.id === billing.tenant.pendingPlanId ? "已排期" : "可选"}</Badge></div><p className="mt-3 text-sm">{money(plan.monthly_fee_minor, String(plan.currency))} / 月</p><p className="mt-1 text-xs text-muted">含 {money(plan.included_credit_minor, String(plan.currency))} 非退款 API 额度</p>{["owner", "admin", "billing"].includes(session.tenant.role) && plan.id !== billing.tenant.planId ? <Button className="mt-4 w-full" size="sm" variant="secondary" onClick={() => void schedulePlan(String(plan.id), load)}>下期切换</Button> : null}</div>)}</div>
          {billing.tenant.pendingPlanId ? <p className="border-t border-border px-5 py-3 text-xs text-warn">已安排在 {date(billing.tenant.planChangeEffectiveAt)} 切换到 {billing.tenant.pendingPlanId}。</p> : null}
        </section>

        <section className="rounded-xl border border-border bg-surface"><div className="border-b border-border px-5 py-4"><h2 className="font-medium">套餐账期历史</h2><p className="mt-1 text-xs text-subtle">每个账期只有一条不可修改记录；未使用的包含额度在续费时到期。</p></div><Rows rows={billing.planPeriods} empty="尚未结算套餐账期" render={(row) => <><div><p className="text-sm font-medium">{String(row.plan_id)} · {date(row.period_start)} – {date(row.period_end)}</p><p className="text-xs text-subtle">月费 {money(row.monthly_fee_minor, String(row.currency))} · 发放 {money(row.included_credit_minor, String(row.currency))} · 到期 {money(row.expired_credit_minor, String(row.currency))}</p></div><Badge tone="ok">{String(row.status)}</Badge></>} /></section>

        <section id="keys" className="rounded-xl border border-border bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4"><div><h2 className="font-medium">API 密钥</h2><p className="mt-1 text-xs text-subtle">完整密钥只显示一次，服务器只保存 SHA-256 哈希。</p></div><CreateKeyDialog onCreated={load} /></div>
          <div className="divide-y divide-border">
            {keys.map((key) => <div key={String(key.id)} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm"><div><p className="font-medium">{String(key.name)}</p><p className="mt-1 font-mono text-xs text-muted">{String(key.key_hint)}</p><p className="mt-1 text-[11px] text-subtle">权限 {(key.scopes as string[] || []).join(" · ")} · 最近使用 {date(key.last_used_at)}</p></div><div className="flex items-center gap-2"><Badge tone={key.enabled && !key.revoked_at ? "ok" : "default"}>{key.enabled && !key.revoked_at ? "启用" : "停用"}</Badge>{key.enabled && !key.revoked_at ? <Button variant="destructive" size="sm" onClick={() => void revokeKey(String(key.id), load)}>撤销</Button> : null}</div></div>)}
            {!keys.length ? <p className="px-5 py-8 text-center text-sm text-subtle">尚未创建 API 密钥</p> : null}
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="font-medium">充值订单</h2><p className="mt-1 text-xs text-subtle">通过 Stripe 托管收银台付款；余额只在已验签 Webhook 确认后入账。</p></div><RechargeDialog currency={billing.tenant.currency} onCreated={load} /></div>
            <Rows rows={billing.orders} empty="暂无订单" render={(row) => <><div><p className="text-sm font-medium">余额充值 {money(row.amount_minor, String(row.currency))}</p><p className="text-xs text-subtle">实付 {money(row.gross_minor || row.amount_minor, String(row.currency))} · 税 {money(row.tax_minor, String(row.currency))} · {date(row.created_at)}{Number(row.refunded_minor || 0) ? ` · 已退余额 ${money(row.refunded_minor, String(row.currency))}` : ""}</p></div><div className="flex items-center gap-2">{row.checkout_url ? <Button size="sm" variant="secondary" onClick={() => window.location.assign(String(row.checkout_url))}>继续付款</Button> : null}<Badge tone={row.status === "paid" ? "ok" : ["checkout_open", "awaiting_payment"].includes(String(row.status)) ? "warn" : "default"}>{String(row.status)}</Badge></div></>} />
          </section>
          <section className="rounded-xl border border-border bg-surface">
            <div className="border-b border-border px-5 py-4"><h2 className="font-medium">资金流水</h2><p className="mt-1 text-xs text-subtle">不可修改的双录账本。</p></div>
            <Rows rows={billing.transactions} empty="暂无流水" render={(row) => <><div><p className="text-sm font-medium">{String(row.kind)}</p><p className="text-xs text-subtle">{date(row.created_at)}</p></div><span className={Number(row.amount_minor) >= 0 ? "text-ok" : "text-danger"}>{money(row.amount_minor, String(row.currency))}</span></>} />
          </section>
        </div>

        <section className="rounded-xl border border-border bg-surface">
          <div className="border-b border-border px-5 py-4"><h2 className="font-medium">最近用量</h2><p className="mt-1 text-xs text-subtle">每笔请求对应价格版本、预授权和最终结算。</p></div>
          <Rows rows={billing.charges} empty="暂无官方 API 调用" render={(row) => <><div><p className="text-sm font-medium">{String(row.provider)} · {String(row.model)}</p><p className="text-xs text-subtle">{String(row.capability)} · {date(row.created_at)}</p></div><div className="text-right"><Badge tone={row.status === "settled" ? "ok" : row.status === "reserved" ? "warn" : "default"}>{String(row.status)}</Badge><p className="mt-1 text-xs text-muted">{money(row.charged_minor, billing.tenant.currency)}</p></div></>} />
        </section>

        {["owner", "admin"].includes(session.tenant.role) ? <section className="rounded-xl border border-border bg-surface"><div className="border-b border-border px-5 py-4"><h2 className="font-medium">租户安全审计</h2><p className="mt-1 text-xs text-subtle">密钥、成员、资金、套餐、MFA 与会话操作均写入不可修改审计链；IP 和浏览器仅保留不可逆 HMAC。</p></div><Rows rows={visibleAudits} empty="暂无高风险操作" render={(row) => <><div><p className="text-sm font-medium">{String(row.action)} · {String(row.target_type)}</p><p className="font-mono text-[11px] text-subtle">{date(row.created_at)} · actor {String(row.actor_user_id).slice(0, 12)} · request {String(row.request_id).slice(0, 12)}</p></div><Badge tone={row.outcome === "succeeded" ? "ok" : row.outcome === "failed" ? "danger" : "warn"}>{String(row.outcome)}</Badge></>} /></section> : null}
        <section id="security" className="rounded-xl border border-border bg-surface p-5"><div className="flex items-center gap-2"><ShieldCheck className="size-4" /><h2 className="font-medium">账户安全</h2></div><p className="mt-2 text-sm text-muted">建议所有 Owner 和 Admin 启用 TOTP 多因素认证。</p><SaasMfaDialog mfaEnabled={session.user.mfaEnabled} /></section>
        <SaasSessionSecurity mfaEnabled={session.user.mfaEnabled} />
        {session.tenant.role === "owner" ? <PrivacyCenter tenantName={session.tenant.name} requests={privacyRequests} reload={load} /> : null}
        <section className="rounded-xl border border-border bg-surface"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="font-medium">企业成员</h2><p className="mt-1 text-xs text-subtle">Owner、Admin、Billing、Developer、Viewer 权限分离；唯一指定 Owner 只能通过原子交接变更。</p></div>{["owner", "admin"].includes(session.tenant.role) ? <InviteMemberDialog onSaved={load} /> : null}</div><div className="divide-y divide-border">{members.map((member) => <div key={String(member.id)} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"><div><p className="text-sm font-medium">{String(member.name)}</p><p className="text-xs text-subtle">{String(member.email)} · MFA {member.mfa_enabled ? "on" : "off"}</p></div><div className="flex items-center gap-2">{member.is_designated_owner ? <Badge tone="warn">指定 Owner</Badge> : <Badge tone={member.membership_status === "active" ? "ok" : "default"}>{String(member.role)}</Badge>}{session.tenant.role === "owner" && member.id !== session.user.id && member.membership_status === "active" ? <TransferOwnershipDialog member={member} /> : null}{session.tenant.role === "owner" && member.id !== session.user.id && !member.is_designated_owner ? <Button variant="ghost" size="sm" onClick={() => void toggleMember(member, load)}>{member.membership_status === "active" ? "停用" : "启用"}</Button> : null}</div></div>)}</div></section>
      </div>
    </SaasShell>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="rounded-xl border border-border bg-surface p-4"><div className="flex items-center gap-2 text-subtle">{icon}<span className="text-xs">{label}</span></div><p className="mt-3 text-2xl font-medium tabular-nums">{value}</p></div>;
}

function Rows({ rows, empty, render }: { rows: Record<string, unknown>[]; empty: string; render: (row: Record<string, unknown>) => React.ReactNode }) {
  return <div className="max-h-80 divide-y divide-border overflow-y-auto">{rows.slice(0, 30).map((row, index) => <div key={String(row.id || index)} className="flex items-center justify-between gap-3 px-5 py-3">{render(row)}</div>)}{!rows.length ? <p className="px-5 py-8 text-center text-sm text-subtle">{empty}</p> : null}</div>;
}

async function revokeKey(id: string, reload: () => Promise<void>) {
  const response = await fetch("/api/saas/keys", { method: "DELETE", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ id }) });
  if (response.ok) { toast.success("密钥已撤销"); await reload(); } else toast.error("撤销失败");
}

async function schedulePlan(planId: string, reload: () => Promise<void>) {
  const response = await fetch("/api/saas/billing", { method: "POST", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ action: "change-plan", planId }) });
  const body = await response.json() as { error?: string };
  if (!response.ok) { toast.error(body.error || "套餐变更失败"); return; }
  toast.success("套餐变更已安排在下一账期生效"); await reload();
}

function CreateKeyDialog({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Production");
  const [models, setModels] = useState("");
  const [secret, setSecret] = useState("");
  async function create() {
    const response = await fetch("/api/saas/keys", { method: "POST", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ name, scopes: ["chat", "image"], modelAllowlist: models.split(",").map((item) => item.trim()).filter(Boolean) }) });
    const body = await response.json() as { secret?: string; error?: string };
    if (!response.ok || !body.secret) { toast.error(body.error || "创建失败"); return; }
    setSecret(body.secret); await onCreated();
  }
  return <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) setSecret(""); }}><DialogTrigger asChild><Button size="sm"><Plus className="size-3.5" />新建密钥</Button></DialogTrigger><DialogContent title="新建租户 API 密钥">{secret ? <div><p className="text-sm text-warn">完整密钥只显示这一次，请立即保存。</p><p className="mt-3 break-all rounded-md bg-elevated p-3 font-mono text-xs">{secret}</p><Button className="mt-3 w-full" onClick={() => { void navigator.clipboard.writeText(secret); toast.success("已复制"); }}><Copy className="size-4" />复制密钥</Button></div> : <div className="space-y-3"><Field label="名称"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="模型白名单（逗号分隔，留空允许套餐模型）"><Input value={models} onChange={(event) => setModels(event.target.value)} placeholder="openai:gpt-5-mini, google:gemini-3.7-flash" /></Field><Button className="w-full" onClick={() => void create()}>创建</Button></div>}</DialogContent></Dialog>;
}

function RechargeDialog({ currency, onCreated }: { currency: string; onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("10");
  async function create() {
    const response = await fetch("/api/saas/billing", { method: "POST", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ action: "checkout", amountMinor: Math.round(Number(amount) * 100), idempotencyKey: crypto.randomUUID() }) });
    const body = await response.json() as { error?: string; checkoutUrl?: string };
    if (!response.ok || !body.checkoutUrl) {
      const unavailable = /^(COMMERCIAL_|PAYMENT_PROVIDER_|STRIPE_.*_MISSING|STRIPE_LIVE_KEY_REQUIRED)/.test(body.error || "");
      toast.error(unavailable ? "商业支付尚未开放，请联系管理员" : body.error || "无法创建安全支付会话");
      return;
    }
    setOpen(false); await onCreated(); window.location.assign(body.checkoutUrl);
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="secondary" size="sm">充值</Button></DialogTrigger><DialogContent title="安全充值"><div className="space-y-3"><Field label={`金额（${currency}）`}><Input type="number" min="1" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field><p className="text-xs text-subtle">下一步将跳转至 Stripe 托管收银台。本系统不接触或保存银行卡信息。</p><Button className="w-full" onClick={() => void create()}>前往安全支付</Button></div></DialogContent></Dialog>;
}

function InviteMemberDialog({ onSaved }: { onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false); const [email, setEmail] = useState(""); const [role, setRole] = useState("developer");
  async function invite() { const response = await fetch("/api/saas/members", { method: "POST", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ email, role }) }); const body = await response.json() as { error?: string }; if (!response.ok) { toast.error(body.error || "邀请失败"); return; } toast.success("邀请邮件已发送"); setOpen(false); await onSaved(); }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button size="sm" variant="secondary">邀请成员</Button></DialogTrigger><DialogContent title="邀请企业成员"><div className="space-y-3"><Field label="邮箱"><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></Field><Field label="角色"><select className="h-11 w-full rounded-sm border border-border bg-elevated px-3 text-sm" value={role} onChange={(event) => setRole(event.target.value)}><option value="admin">Admin</option><option value="billing">Billing</option><option value="developer">Developer</option><option value="viewer">Viewer</option></select></Field><Button className="w-full" onClick={() => void invite()}>发送邀请</Button></div></DialogContent></Dialog>;
}

function TransferOwnershipDialog({ member }: { member: Record<string, unknown> }) {
  const [open, setOpen] = useState(false); const [confirmation, setConfirmation] = useState("");
  const email = String(member.email || "");
  async function transfer() {
    const response = await fetch("/api/saas/members", { method: "PATCH", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ action: "transfer-ownership", userId: member.id }) });
    const body = await response.json() as { error?: string };
    if (!response.ok) { toast.error(body.error || "所有权交接失败"); return; }
    toast.success("所有权已交接，你的角色已变为 Admin"); setOpen(false); window.location.reload();
  }
  return <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) setConfirmation(""); }}><DialogTrigger asChild><Button variant="secondary" size="sm" disabled={!member.mfa_enabled}>移交所有权</Button></DialogTrigger><DialogContent title="原子移交租户所有权"><div className="space-y-3"><p className="text-sm text-warn">目标将成为唯一指定 Owner，你将降级为 Admin。目标必须是已启用 MFA 的活跃成员。</p><Field label={`输入目标邮箱“${email}”确认`}><Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field><Button className="w-full" variant="destructive" disabled={confirmation!==email} onClick={() => void transfer()}>确认移交所有权</Button></div></DialogContent></Dialog>;
}

async function toggleMember(member: Record<string, unknown>, reload: () => Promise<void>) {
  const status = member.membership_status === "active" ? "disabled" : "active";
  const response = await fetch("/api/saas/members", { method: "PATCH", credentials: "include", headers: saasMutationHeaders(), body: JSON.stringify({ userId: member.id, role: member.role, status }) });
  const body = await response.json() as { error?: string };
  if (!response.ok) { toast.error(body.error || "成员更新失败"); return; }
  toast.success("成员状态已更新"); await reload();
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-2"><Label>{label}</Label>{children}</div>; }
