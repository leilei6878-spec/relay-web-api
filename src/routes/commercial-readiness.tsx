import { createFileRoute } from "@tanstack/react-router";
import { ClipboardCheck, Clock3, FileCheck2, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/commercial-readiness")({ component: CommercialReadinessPage });

type Evidence = {
  id: string; requirement: string; subject: string; version: number; status: string;
  artifactRef: string; artifactSha256: string; note: string; recordedBy: string;
  reviewedBy: string; observedAt: string; validUntil: string; recordedAt: string;
};

type Requirement = {
  requirement: string; subject: string; label: string; description: string;
  maxValidityDays: number; valid: boolean;
  reason: "missing" | "passed" | "failed" | "revoked" | "expired" | "not_yet_observed";
  evidence: Evidence | null;
};

type Snapshot = { requirements: Requirement[]; history: Evidence[]; error?: string };

const reasonLabel: Record<Requirement["reason"], string> = {
  missing: "缺失", passed: "有效", failed: "未通过", revoked: "已撤销", expired: "已过期", not_yet_observed: "时间异常",
};

function CommercialReadinessPage() {
  return <AppShell><CommercialReadinessView /></AppShell>;
}

function CommercialReadinessView() {
  const [data, setData] = useState<Snapshot>({ requirements: [], history: [] });
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Requirement | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/commercial-evidence", { credentials: "include" });
      const body = await response.json() as Snapshot;
      if (!response.ok) throw new Error(body.error || "商业证据读取失败");
      setData({ requirements: body.requirements || [], history: body.history || [] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "商业证据读取失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const valid = data.requirements.filter((item) => item.valid).length;
  const expiring = useMemo(() => data.requirements.filter((item) => {
    if (!item.valid || !item.evidence) return false;
    return Date.parse(item.evidence.validUntil) - Date.now() < 7 * 86_400_000;
  }).length, [data.requirements]);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl font-medium">商业发布证据</h1><p className="mt-1 text-sm text-muted">配置开关不能代替合同、复核和真实演练；每项证据均追加保存、带 SHA-256 和有效期。</p></div>
        <Button variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw className="size-4" />刷新</Button>
      </header>
      <div className="rounded-xl border border-warn/30 bg-warn/5 p-4 text-sm text-muted">
        <div className="flex items-center gap-2 text-warn"><ShieldAlert className="size-4" /><span className="font-medium">不能伪造外部事实</span></div>
        <p className="mt-2">“通过”必须对应真实文档或测试产物，由不同于录入管理员的复核人确认。后续失败或撤销只能新增版本，历史不能修改或删除。</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat icon={<ClipboardCheck className="size-4" />} label="要求总数" value={data.requirements.length} />
        <Stat icon={<FileCheck2 className="size-4" />} label="当前有效" value={valid} />
        <Stat icon={<Clock3 className="size-4" />} label="7 天内到期" value={expiring} />
      </div>
      <section className="overflow-x-auto rounded-xl border border-border bg-surface">
        <div className="border-b border-border px-5 py-4"><h2 className="font-medium">公开收费硬要求</h2><p className="mt-1 text-xs text-subtle">供应商授权和价格复核会根据有效价格版本动态增加。</p></div>
        <table className="w-full min-w-[1000px] text-left text-sm">
          <thead className="text-xs text-subtle"><tr><th className="px-4 py-3">要求</th><th>范围</th><th>状态</th><th>复核人</th><th>有效期</th><th>证据引用</th><th>操作</th></tr></thead>
          <tbody>{data.requirements.map((item) => <tr key={`${item.requirement}:${item.subject}`} className="border-t border-border">
            <td className="px-4 py-3"><p className="font-medium">{item.label}</p><p className="mt-1 max-w-md text-xs text-subtle">{item.description}</p></td>
            <td className="font-mono text-xs">{item.subject}</td>
            <td><Badge tone={item.valid ? "ok" : item.reason === "expired" ? "warn" : "danger"}>{reasonLabel[item.reason]}</Badge></td>
            <td className="text-xs text-muted">{item.evidence?.reviewedBy || "—"}</td>
            <td className="text-xs text-muted">{item.evidence ? new Date(item.evidence.validUntil).toLocaleString("zh-CN") : "—"}</td>
            <td className="max-w-56 truncate font-mono text-xs text-muted" title={item.evidence?.artifactRef}>{item.evidence?.artifactRef || "—"}</td>
            <td><Button size="sm" variant="secondary" onClick={() => setSelected(item)}>追加证据</Button></td>
          </tr>)}</tbody>
        </table>
      </section>
      <section className="rounded-xl border border-border bg-surface">
        <div className="border-b border-border px-5 py-4"><h2 className="font-medium">不可变历史</h2></div>
        <div className="max-h-96 divide-y divide-border overflow-y-auto">{data.history.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div><p className="text-sm font-medium">{item.requirement}:{item.subject} · v{item.version}</p><p className="mt-1 font-mono text-[11px] text-subtle">SHA-256 {item.artifactSha256} · {item.artifactRef}</p></div>
          <div className="text-right"><Badge tone={item.status === "passed" ? "ok" : item.status === "revoked" ? "warn" : "danger"}>{item.status}</Badge><p className="mt-1 text-xs text-subtle">复核 {item.reviewedBy}</p></div>
        </div>)}{!data.history.length ? <p className="px-5 py-8 text-center text-sm text-subtle">尚未录入证据</p> : null}</div>
      </section>
      <EvidenceDialog requirement={selected} onClose={() => setSelected(null)} onSaved={async () => { setSelected(null); await load(); }} />
    </div>
  );
}

function localInput(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function EvidenceDialog({ requirement, onClose, onSaved }: { requirement: Requirement | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [status, setStatus] = useState("passed");
  const [artifactRef, setArtifactRef] = useState("");
  const [artifactSha256, setArtifactSha256] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [note, setNote] = useState("");
  const [observedAt, setObservedAt] = useState(localInput(new Date()));
  const [validUntil, setValidUntil] = useState(localInput(new Date(Date.now() + 30 * 86_400_000)));
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!requirement) return;
    setStatus("passed"); setArtifactRef(""); setArtifactSha256(""); setReviewer(""); setNote(""); setConfirmation("");
    setObservedAt(localInput(new Date()));
    setValidUntil(localInput(new Date(Date.now() + requirement.maxValidityDays * 86_400_000)));
  }, [requirement]);

  async function save() {
    if (!requirement) return;
    setSaving(true);
    try {
      const response = await fetch("/api/admin/commercial-evidence", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirement: requirement.requirement, subject: requirement.subject, status, artifactRef, artifactSha256, reviewer, note, observedAt: new Date(observedAt).toISOString(), validUntil: new Date(validUntil).toISOString(), confirmation }),
      });
      const body = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || "证据录入失败");
      toast.success("证据版本已追加");
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "证据录入失败");
    } finally {
      setSaving(false);
    }
  }

  return <Dialog open={Boolean(requirement)} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent title={requirement ? `追加证据 · ${requirement.label}` : "追加证据"}><div className="space-y-3">
    <Field label="结论"><Select value={status} onValueChange={setStatus}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="passed">通过</SelectItem><SelectItem value="failed">未通过</SelectItem><SelectItem value="revoked">撤销旧证据</SelectItem></SelectContent></Select></Field>
    <Field label="证据引用（HTTPS 无参数链接或工单编号）"><Input value={artifactRef} onChange={(event) => setArtifactRef(event.target.value)} placeholder="LEGAL-2026-001" /></Field>
    <Field label="证据文件 SHA-256"><Input className="font-mono" value={artifactSha256} onChange={(event) => setArtifactSha256(event.target.value)} maxLength={64} placeholder="64 位十六进制" /></Field>
    <Field label="独立复核人（不得为 admin）"><Input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="reviewer@example.com" /></Field>
    <Field label="复核说明"><Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} /></Field>
    <div className="grid gap-3 sm:grid-cols-2"><Field label="证据观察时间"><Input type="datetime-local" value={observedAt} onChange={(event) => setObservedAt(event.target.value)} /></Field><Field label={`有效期（最长 ${requirement?.maxValidityDays || 0} 天）`}><Input type="datetime-local" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} /></Field></div>
    <Field label="确认短语"><Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="EVIDENCE_REVIEWED" /></Field>
    <p className="text-xs text-subtle">系统不保存证据文件正文；请将文件保存在批准的文档系统并填写其 SHA-256。不得粘贴 API Key、Webhook Secret 或私钥。</p>
    <Button className="w-full" onClick={() => void save()} disabled={saving || confirmation !== "EVIDENCE_REVIEWED"}>{saving ? "保存中…" : "追加不可变证据"}</Button>
  </div></DialogContent></Dialog>;
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) { return <div className="rounded-xl border border-border bg-surface p-4"><div className="flex items-center gap-2 text-xs text-subtle">{icon}{label}</div><p className="mt-3 text-2xl font-medium">{value}</p></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-2"><Label>{label}</Label>{children}</div>; }
