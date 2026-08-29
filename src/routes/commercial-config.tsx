import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, FlaskConical, History, Plus, RotateCcw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

export const Route = createFileRoute("/commercial-config")({ component: CommercialConfigPage });

type Version = {
  id: string; version: number; status: string; value: unknown; secret: boolean; secretHint: string | null;
  validationStatus: string; testDetail: Record<string, unknown>; reason: string; createdBy: string;
  createdAt: string; testedAt: string | null; activatedAt: string | null;
};

type Entry = {
  key: string; label: string; group: string; kind: string; envName: string; secret?: boolean; hardGate?: boolean;
  allowed?: string[]; min?: number; max?: number; description: string; envConfigured: boolean; hardGateOpen: boolean | null;
  versions: Version[]; active: Version | null;
};

const groupNames: Record<string, string> = {
  launch: "上线门禁", providers: "官方供应商", payments: "支付与税务", delivery: "邮件与告警", retention: "数据保留",
};

function CommercialConfigPage() {
  return <AppShell><CommercialConfigView /></AppShell>;
}

function CommercialConfigView() {
  const [catalog, setCatalog] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/admin/commercial-config", { credentials: "include" });
    const body = await response.json() as { catalog?: Entry[]; error?: string };
    if (!response.ok) toast.error(body.error || "配置读取失败");
    else setCatalog(body.catalog || []);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const groups = useMemo(() => [...new Set(catalog.map((entry) => entry.group))], [catalog]);
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header><h1 className="text-2xl font-medium">商业配置中心</h1><p className="mt-1 text-sm text-muted">固定目录、版本化测试与发布。密钥加密保存且永不回显；部署硬门禁始终拥有最终否决权。</p></header>
      <div className="rounded-xl border border-warn/30 bg-warn/5 p-4 text-sm text-muted"><div className="flex items-center gap-2 text-warn"><ShieldAlert className="size-4" /><span className="font-medium">配置不是外部事实</span></div><p className="mt-2">本页不能伪造商业合同、法务批准、HA 副本或异地备份。连接测试通过也不等于完成真实付费验收。</p></div>
      {groups.map((group) => <section key={group} className="space-y-3"><h2 className="text-lg font-medium">{groupNames[group] || group}</h2><div className="grid gap-4 lg:grid-cols-2">{catalog.filter((entry) => entry.group === group).map((entry) => <ConfigCard key={entry.key} entry={entry} reload={load} />)}</div></section>)}
      {loading ? <p className="text-sm text-muted">正在读取配置…</p> : null}
    </div>
  );
}

function ConfigCard({ entry, reload }: { entry: Entry; reload: () => Promise<void> }) {
  const active = entry.active;
  return (
    <article className="rounded-xl border border-border bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-border p-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{entry.label}</h3>{entry.secret ? <Badge tone="warn">Secret</Badge> : null}{entry.hardGate ? <Badge tone={entry.hardGateOpen ? "ok" : "danger"}>硬门禁 {entry.hardGateOpen ? "open" : "closed"}</Badge> : null}</div><p className="mt-1 font-mono text-[11px] text-subtle">{entry.key} · {entry.envName}</p><p className="mt-2 text-xs text-muted">{entry.description}</p></div><CreateVersionDialog entry={entry} onSaved={reload} /></div>
      <div className="p-4"><div className="flex items-center justify-between"><span className="text-xs text-subtle">当前生效</span>{active ? <Badge tone="ok">v{active.version}</Badge> : <Badge>使用部署回退</Badge>}</div><p className="mt-2 break-all text-sm">{active ? displayValue(active) : entry.envConfigured ? "环境变量已配置（值隐藏）" : "未配置"}</p></div>
      <div className="max-h-64 divide-y divide-border overflow-y-auto border-t border-border">{entry.versions.slice(0, 8).map((version) => <VersionRow key={version.id} version={version} reload={reload} />)}{!entry.versions.length ? <p className="p-4 text-center text-xs text-subtle">暂无版本</p> : null}</div>
    </article>
  );
}

function displayValue(version: Version) {
  if (version.secret) return version.secretHint || "••••••••";
  return typeof version.value === "object" ? JSON.stringify(version.value) : String(version.value);
}

function VersionRow({ version, reload }: { version: Version; reload: () => Promise<void> }) {
  const busy = version.status === "draft";
  return <div className="flex flex-wrap items-center justify-between gap-3 p-3 text-xs"><div><div className="flex items-center gap-2"><span className="font-medium">v{version.version}</span><Badge tone={version.validationStatus === "passed" ? "ok" : version.validationStatus === "failed" ? "danger" : "warn"}>{version.validationStatus}</Badge><Badge>{version.status}</Badge></div><p className="mt-1 text-subtle">{version.reason || "无说明"} · {new Date(version.createdAt).toLocaleString("zh-CN")}</p></div><div className="flex gap-2">{busy ? <Button size="sm" variant="secondary" onClick={() => void configAction({ action: "test", id: version.id }, "连接/格式测试完成", reload)}><FlaskConical className="size-3.5" />测试</Button> : null}{busy && version.validationStatus === "passed" ? <Button size="sm" onClick={() => void configAction({ action: "activate", id: version.id }, "配置已发布", reload)}><CheckCircle2 className="size-3.5" />发布</Button> : null}{version.status === "retired" && version.validationStatus === "passed" ? <Button size="sm" variant="secondary" onClick={() => void configAction({ action: "rollback", id: version.id }, "已回滚到历史版本", reload)}><RotateCcw className="size-3.5" />回滚</Button> : null}</div></div>;
}

function CreateVersionDialog({ entry, onSaved }: { entry: Entry; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(entry.kind === "boolean" ? "false" : entry.kind === "json" ? "{}" : entry.allowed?.[0] || "");
  const [reason, setReason] = useState("");
  async function create() {
    let value: unknown = raw;
    try {
      if (entry.kind === "boolean") value = raw === "true";
      else if (entry.kind === "integer") value = Number(raw);
      else if (entry.kind === "json") value = JSON.parse(raw);
      const saved = await configAction({ action: "create", key: entry.key, value, reason }, "草稿版本已创建", onSaved);
      if (!saved) return;
      setOpen(false); setReason(""); if (entry.secret) setRaw("");
    } catch (error) { toast.error(error instanceof Error ? error.message : "配置格式无效"); }
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button size="sm" variant="secondary"><Plus className="size-3.5" />新版本</Button></DialogTrigger><DialogContent title={`${entry.label} · 新版本`}><div className="space-y-3">{entry.kind === "json" ? <Field label="JSON 对象"><textarea className="min-h-32 w-full rounded-md border border-border bg-elevated p-3 font-mono text-xs" value={raw} onChange={(event) => setRaw(event.target.value)} /></Field> : entry.kind === "boolean" ? <Field label="期望状态"><select className="h-11 w-full rounded-sm border border-border bg-elevated px-3" value={raw} onChange={(event) => setRaw(event.target.value)}><option value="false">关闭</option><option value="true">开启</option></select></Field> : entry.kind === "enum" ? <Field label="值"><select className="h-11 w-full rounded-sm border border-border bg-elevated px-3" value={raw} onChange={(event) => setRaw(event.target.value)}>{entry.allowed?.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field> : <Field label={entry.secret ? "新密钥（保存后不再显示）" : "值"}><Input type={entry.secret ? "password" : entry.kind === "integer" ? "number" : "text"} min={entry.min} max={entry.max} value={raw} onChange={(event) => setRaw(event.target.value)} autoComplete="new-password" /></Field>}<Field label="变更原因"><Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="必填：工单、轮换或业务原因" /></Field><Button className="w-full" onClick={() => void create()}><History className="size-4" />保存不可变草稿</Button></div></DialogContent></Dialog>;
}

async function configAction(body: Record<string, unknown>, success: string, reload: () => Promise<void>) {
  const response = await fetch("/api/admin/commercial-config", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || !result.ok) { toast.error(result.error || "配置操作失败"); return false; }
  toast.success(success); await reload(); return true;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>;
}
