import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listEligible } from "@/lib/eligibility";
import { getApiKey } from "@/lib/gateway";
import { isCallable, nextStep, whyBlocked } from "@/lib/readiness";
import { onlineWorkerCount } from "@/lib/runtime-view";
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
  const proxies = useGateway((s) => s.proxies);
  const settings = useGateway((s) => s.settings);
  const [runtime, setRuntime] = useState<{
    workerOnline: boolean;
    workers: { name: string; online: boolean }[];
    queued: number;
    serverWorker?: { running?: boolean; pid?: number; name?: string };
  } | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/runtime")
        .then((r) => r.json())
        .then((b) => setRuntime(b as typeof runtime))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const step = nextStep({ accounts, proxies, settings });
  const gpt = listEligible(accounts, proxies, settings, "chatgpt").length;
  const blocked = accounts.filter((a) => !isCallable(a, proxies, settings));

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-2xl font-medium tracking-tight">把网页变成 API</h1>
        <p className="mt-2 text-sm text-muted">
          登录一次（走该号的 sticky IP），之后请求由服务器上的执行器打开网页。不必给每个调用方下载 Worker。
        </p>
      </header>

      <section className="rounded-xl border border-border bg-surface p-5">
        <p className="text-xs text-muted">下一步</p>
        <h2 className="mt-1 text-lg font-medium">{step.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{step.detail}</p>
        <Button asChild className="mt-4">
          <Link to={step.href}>{step.cta}</Link>
        </Button>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "ChatGPT 可调用", value: gpt, hint: "已登录且绑了代理" },
          { label: "网页执行器", value: runtime?.workerOnline ? "在线" : "离线", hint: runtime?.workerOnline ? "返回网页原文" : "接口将 503" },
          {
            label: "队列中",
            value: runtime?.queued ?? 0,
            hint: `${onlineWorkerCount(runtime)} 台 Worker`,
          },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-border bg-surface p-5">
            <p className="text-xs text-muted">{s.label}</p>
            <p className="mt-3 font-mono text-3xl tabular-nums tracking-tight">{s.value}</p>
            <p className="mt-2 text-xs text-subtle">{s.hint}</p>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">服务器执行器</h2>
            <p className="mt-1 text-xs text-subtle">
              和网关跑在同一台机器，按账号绑定的代理出网。本机下载包只用于第一次登录。
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void (async () => {
                  const key = await getApiKey();
                  const res = await fetch("/api/worker/control", {
                    method: "POST",
                    credentials: "include",
                    headers: {
                      ...(key.apiKey.trim() ? { Authorization: `Bearer ${key.apiKey.trim()}` } : {}),
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ action: runtime?.serverWorker?.running ? "stop" : "start" }),
                  });
                  const body = (await res.json()) as { error?: string; running?: boolean };
                  if (!res.ok) toast.error(body.error || "操作失败");
                  else toast.success(body.running ? "服务器执行器已启动" : "已停止");
                  const next = await fetch("/api/runtime").then((r) => r.json());
                  setRuntime(next as typeof runtime);
                })();
              }}
            >
              {runtime?.serverWorker?.running ? "停止" : "启动"}
            </Button>
          </div>
        </div>
        <ul className="mt-3 space-y-2 text-sm">
          {(runtime?.workers || []).length === 0 && (
            <p className="text-muted">执行器还没有心跳。点启动，或检查 python3 / playwright。</p>
          )}
          {(runtime?.workers || []).map((w) => (
            <li key={w.name} className="flex items-center justify-between gap-3">
              <span className="font-mono text-xs">{w.name}</span>
              <Badge tone={w.online ? "ok" : undefined}>{w.online ? "在线" : "离线"}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-medium">账号能不能被 API 选中</h2>
        <ul className="mt-4 space-y-3">
          {accounts.slice(0, 8).map((a) => {
            const reason = whyBlocked(a, proxies, settings);
            return (
              <li key={a.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{a.email}</p>
                  <p className="mt-0.5 text-[11px] text-subtle">{reason ?? "可以调用"}</p>
                </div>
                {reason ? <Badge>未就绪</Badge> : <Badge tone="ok">可调用</Badge>}
              </li>
            );
          })}
          {accounts.length === 0 && <p className="text-sm text-muted">还没有账号</p>}
        </ul>
        {blocked.length > 0 && (
          <p className="mt-3 text-xs text-subtle">{blocked.length} 个账号还不能进调度，优先去登录或绑代理。</p>
        )}
      </section>

      {logs.length > 0 && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">最近调用</h2>
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
                    {l.accountEmail} · {l.detail}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted">{formatTime(l.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
