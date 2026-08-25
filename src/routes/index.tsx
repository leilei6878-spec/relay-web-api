import { createFileRoute, Link } from "@tanstack/react-router";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listEligible } from "@/lib/eligibility";
import { useGateway } from "@/lib/store";
import { formatTime } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <AppShell>
      <Dashboard />
    </AppShell>
  );
}

function Dashboard() {
  const accounts = useGateway((s) => s.accounts);
  const logs = useGateway((s) => s.logs);
  const workers = useGateway((s) => s.workers);
  const proxies = useGateway((s) => s.proxies);
  const settings = useGateway((s) => s.settings);

  const healthy = accounts.filter((a) => a.status === "healthy").length;
  const pending = accounts.filter((a) => a.status === "pending_login").length;
  const down = accounts.filter((a) => a.status === "invalid" || a.status === "banned").length;
  const gpt = listEligible(accounts, proxies, settings, "chatgpt").length;
  const gem = listEligible(accounts, proxies, settings, "gemini").length;
  const locked = accounts.filter(
    (a) => a.lockedUntil && new Date(a.lockedUntil).getTime() > Date.now(),
  ).length;
  const success = logs.filter((l) => l.status === "success").length;
  const switched = logs.filter((l) => l.status === "switched").length;
  const rate = logs.length ? Math.round((success / logs.length) * 100) : 100;

  const chart = Array.from({ length: 12 }).map((_, i) => ({
    t: `${i + 1}h`,
    req: Math.max(2, 8 + ((i * 7) % 11) - (i % 3)),
  }));

  const stats = [
    { label: "健康账号", value: healthy, hint: `待登录 ${pending} · 失效 ${down}` },
    { label: "可调度 ChatGPT", value: gpt, hint: "Session + sticky" },
    { label: "可调度 Gemini", value: gem, hint: "Session + sticky" },
    { label: "成功率", value: `${rate}%`, hint: `换号 ${switched} · 占用 ${locked}` },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted">控制平面</p>
          <h1 className="mt-1 text-2xl font-medium tracking-tight">总览</h1>
          <p className="mt-2 max-w-xl text-sm text-muted">
            商业交付看下面清单。ChatGPT 对话 API 已接通任务队列；Gemini 出图和 Vision 还没有。
          </p>
        </div>
        <Button asChild>
          <Link to="/playground">打开试运行</Link>
        </Button>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-border bg-surface p-5">
            <p className="text-xs text-muted">{s.label}</p>
            <p className="mt-3 font-mono text-3xl tabular-nums tracking-tight">{s.value}</p>
            <p className="mt-2 text-xs text-subtle">{s.hint}</p>
          </div>
        ))}
      </section>

      <DeliveryChecklist gpt={gpt} gem={gem} healthy={healthy} />

      <section className="grid gap-4 lg:grid-cols-5">
        <div className="rounded-xl border border-border bg-surface p-5 lg:col-span-3">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium">近 12 小时请求</h2>
            <span className="text-xs text-subtle">吞吐示意</span>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart}>
                <defs>
                  <linearGradient id="req" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#c5cbc4" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#c5cbc4" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" tick={{ fill: "#8a8a86", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip
                  contentStyle={{
                    background: "#1b1c20",
                    border: "1px solid #2a2b30",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area type="monotone" dataKey="req" stroke="#c5cbc4" fill="url(#req)" strokeWidth={1.5} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface p-5 lg:col-span-2">
          <h2 className="text-sm font-medium">Worker 节点</h2>
          <ul className="mt-4 space-y-3">
            {workers.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-3 rounded-md bg-elevated px-3 py-2.5">
                <div>
                  <p className="font-mono text-xs">{w.name}</p>
                  <p className="text-[11px] text-subtle">{w.region}</p>
                </div>
                <div className="text-right">
                  {w.online ? <Badge tone="ok">在线</Badge> : <Badge>离线</Badge>}
                  <p className="mt-1 font-mono text-[11px] tabular-nums text-muted">
                    并发 {w.concurrency}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">最近日志</h2>
            <Link to="/logs" className="text-xs text-muted hover:text-fg">
              全部
            </Link>
          </div>
          <ul className="space-y-2">
            {logs.slice(0, 5).map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3 border-b border-border py-2 last:border-0">
                <div className="min-w-0">
                  <p className="truncate text-sm">{l.promptPreview}</p>
                  <p className="mt-0.5 text-[11px] text-subtle">
                    {l.accountEmail} · {l.latencyMs}ms · {l.detail}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted">{formatTime(l.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-medium">代理组</h2>
          <ul className="mt-4 space-y-3">
            {proxies.map((p) => {
              const bound = accounts.filter((a) => a.proxyId === p.id).length;
              return (
                <li key={p.id} className="flex items-center justify-between">
                  <div>
                    <p className="text-sm">{p.name}</p>
                    <p className="text-[11px] text-subtle">
                      {p.region} · sticky {p.stickySessionId}
                    </p>
                  </div>
                  <p className="font-mono text-xs tabular-nums text-muted">
                    {bound}/{p.maxAccounts}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </div>
  );
}

function DeliveryChecklist({ gpt, gem, healthy }: { gpt: number; gem: number; healthy: number }) {
  const items = [
    { ok: healthy > 0, label: "至少 1 个健康账号" },
    { ok: gpt > 0, label: "ChatGPT 可调度（Session + sticky）" },
    { ok: true, label: "对外 POST /v1/chat/completions" },
    { ok: true, label: "本机 Worker 拉任务（需在电脑上常开）" },
    { ok: gem > 0, label: "Gemini 账号就绪" },
    { ok: true, label: "Gemini 网页出图 API" },
    { ok: false, label: "ChatGPT Vision / 多模态" },
    { ok: false, label: "流式 SSE 与用量计费" },
  ];
  const done = items.filter((i) => i.ok).length;
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">商业交付清单</h2>
        <span className="font-mono text-xs text-muted">
          {done}/{items.length}
        </span>
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {items.map((i) => (
          <li key={i.label} className="flex items-center gap-2 text-sm">
            <Badge tone={i.ok ? "ok" : "warn"}>{i.ok ? "已有" : "未交付"}</Badge>
            <span className={i.ok ? "text-muted" : "text-subtle"}>{i.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
