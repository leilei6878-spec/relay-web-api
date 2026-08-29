import { createFileRoute } from "@tanstack/react-router";
import { FlaskConical, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

export const Route = createFileRoute("/commercial-sandbox")({ component: ProviderSandboxPage });

type Price = { id: string; provider: string; model: string; capability: string; currency: string; status: string; image_price_minor: number };
type Run = { id: string; provider: string; model: string; capability: string; status: string; currency: string; estimatedChargeMinor: number; promptTokens: number; completionTokens: number; images: number; errorCode: string | null; errorMessage: string | null; startedAt: string; finishedAt: string | null };

function ProviderSandboxPage() { return <AppShell><ProviderSandboxView /></AppShell>; }

function ProviderSandboxView() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [prices, setPrices] = useState<Price[]>([]);
  const [gate, setGate] = useState(false);
  const [maximum, setMaximum] = useState(0);
  const load = useCallback(async () => {
    const [sandboxResponse, commercialResponse] = await Promise.all([
      fetch("/api/admin/provider-sandbox", { credentials: "include" }),
      fetch("/api/admin/commercial", { credentials: "include" }),
    ]);
    const sandbox = await sandboxResponse.json() as { runs?: Run[]; hardGateOpen?: boolean; maxChargeMinor?: number; error?: string };
    const commercial = await commercialResponse.json() as { prices?: Price[]; error?: string };
    if (!sandboxResponse.ok || !commercialResponse.ok) { toast.error(sandbox.error || commercial.error || "沙箱数据读取失败"); return; }
    setRuns(sandbox.runs || []); setGate(Boolean(sandbox.hardGateOpen)); setMaximum(Number(sandbox.maxChargeMinor || 0));
    setPrices((commercial.prices || []).filter((price) => price.status === "active" && ["openai", "google", "vertex", "leonardo"].includes(price.provider)));
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <div className="mx-auto max-w-7xl space-y-6"><header className="flex items-end justify-between gap-3"><div><h1 className="text-2xl font-medium">官方供应商沙箱</h1><p className="mt-1 text-sm text-muted">使用固定最小提示执行真实上游 canary；不保存文本、图片或原始响应。</p></div><div className="flex gap-2"><RunDialog prices={prices} gate={gate} reload={load} /><Button variant="secondary" onClick={() => void load()}><RefreshCw className="size-4" />刷新</Button></div></header><div className="rounded-xl border border-warn/30 bg-warn/5 p-4"><div className="flex items-center gap-2"><ShieldAlert className="size-4 text-warn" /><span className="font-medium">真实费用硬门禁：{gate ? "已开启" : "已关闭"}</span></div><p className="mt-2 text-sm text-muted">单次估算收费上限：{maximum} 最小货币单位。只有已发布价格的精确 provider/model/capability 可执行；需输入确认短语。</p></div><section className="rounded-xl border border-border bg-surface"><div className="border-b border-border px-5 py-4"><h2 className="font-medium">执行证据</h2></div><div className="divide-y divide-border">{runs.map((run) => <div key={run.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"><div><p className="text-sm font-medium">{run.provider} · {run.model} · {run.capability}</p><p className="mt-1 text-xs text-subtle">{new Date(run.startedAt).toLocaleString("zh-CN")} · 估算 {run.estimatedChargeMinor} {run.currency} minor · tokens {run.promptTokens}/{run.completionTokens} · images {run.images}</p>{run.errorCode ? <p className="mt-1 text-xs text-danger">{run.errorCode}: {run.errorMessage}</p> : null}</div><Badge tone={run.status === "passed" ? "ok" : run.status === "failed" ? "danger" : "warn"}>{run.status}</Badge></div>)}{!runs.length ? <p className="px-5 py-10 text-center text-sm text-subtle">暂无真实 canary 记录</p> : null}</div></section></div>;
}

function RunDialog({ prices, gate, reload }: { prices: Price[]; gate: boolean; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false); const [priceId, setPriceId] = useState(""); const [confirmation, setConfirmation] = useState("");
  const selected = prices.find((price) => price.id === priceId) || prices[0];
  async function run() {
    if (!selected) { toast.error("没有已发布价格路由"); return; }
    const response = await fetch("/api/admin/provider-sandbox", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: selected.provider, model: selected.model, capability: selected.capability, currency: selected.currency, confirmation }) });
    const body = await response.json() as { ok?: boolean; error?: string; run?: Run };
    if (!response.ok || !body.ok) { toast.error(body.error || body.run?.errorCode || "Canary 失败"); await reload(); return; }
    toast.success("官方供应商 canary 已通过"); setOpen(false); setConfirmation(""); await reload();
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button disabled={!gate || !prices.length}><FlaskConical className="size-4" />执行真实 Canary</Button></DialogTrigger><DialogContent title="确认真实供应商 Canary"><div className="space-y-3"><Field label="已发布价格路由"><select className="h-11 w-full rounded-sm border border-border bg-elevated px-3 text-sm" value={selected?.id || ""} onChange={(event) => setPriceId(event.target.value)}>{prices.map((price) => <option key={price.id} value={price.id}>{price.provider} · {price.model} · {price.capability} · {price.currency}</option>)}</select></Field><p className="text-xs text-warn">此操作会调用真实官方 API 并产生上游费用。固定提示和结果内容不会写入数据库。</p><Field label="输入 LIVE_COST_ACCEPTED"><Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></Field><Button className="w-full" variant="destructive" disabled={confirmation !== "LIVE_COST_ACCEPTED"} onClick={() => void run()}>确认产生真实费用并执行</Button></div></DialogContent></Dialog>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-2"><Label>{label}</Label>{children}</div>; }
