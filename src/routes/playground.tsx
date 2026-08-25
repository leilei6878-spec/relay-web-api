import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { getApiKey } from "@/lib/gateway";
import { LOCAL_WORKER, localWorkerScript } from "@/lib/local-worker-script";
import { textFile, zipStore } from "@/lib/zip-store";
import { useGateway } from "@/lib/store";
import type { Platform } from "@/lib/types";

export const Route = createFileRoute("/playground")({ component: Page });

function Page() {
  return (
    <AppShell>
      <Playground />
    </AppShell>
  );
}

type Step = { label: string; state: "run" | "ok" | "fail" | "skip" };

function Playground() {
  const [mode, setMode] = useState<"chat" | "image">("chat");
  const [prompt, setPrompt] = useState("用三句话说明为什么账号必须绑定 sticky IP。");
  const [reply, setReply] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [used, setUsed] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [forceFailFirst, setForceFailFirst] = useState(false);
  const [liveWeb, setLiveWeb] = useState(true);
  const [switched, setSwitched] = useState(0);
  const [workerOn, setWorkerOn] = useState<boolean | null>(null);

  const pickHealthy = useGateway((s) => s.pickHealthy);
  const markAccountUsed = useGateway((s) => s.markAccountUsed);
  const addLog = useGateway((s) => s.addLog);
  const settings = useGateway((s) => s.settings);

  useEffect(() => {
    void pingWorker();
    const t = setInterval(() => void pingWorker(), 4000);
    return () => clearInterval(t);
  }, []);

  async function pingWorker() {
    try {
      const res = await fetch(`${LOCAL_WORKER}/health`, { signal: AbortSignal.timeout(1500) });
      const body = (await res.json()) as { ok?: boolean };
      setWorkerOn(Boolean(body.ok));
      return Boolean(body.ok);
    } catch {
      setWorkerOn(false);
      return false;
    }
  }

  async function downloadWorker() {
    const key = await getApiKey();
    const origin = window.location.origin;
    const bat = `@echo off
cd /d "%~dp0"
set RELAY_GATEWAY=${origin}
set RELAY_TOKEN=${key.apiKey}
python -m pip install playwright -q
python -m playwright install chromium
python worker.py
pause
`;
    const blob = zipStore([
      { name: "worker.py", data: textFile(localWorkerScript()) },
      { name: "run-worker.bat", data: textFile(bat) },
      {
        name: "README.txt",
        data: textFile("Keep v2rayN on, run run-worker.bat, then send from the playground.\n"),
      },
    ]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "relay-local-worker.zip";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("已下载本机 Worker");
  }

  async function runViaApi(kind: "chat" | "image", promptText: string) {
    const runtime = await fetch("/api/runtime").then((r) => r.json() as Promise<{ apiKey: string }>);
    const res = await fetch(kind === "chat" ? "/v1/chat/completions" : "/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtime.apiKey}`,
      },
      body: JSON.stringify(
        kind === "chat"
          ? { model: "gpt-4o", messages: [{ role: "user", content: promptText }] }
          : { prompt: promptText },
      ),
    });
    const body = (await res.json()) as {
      error?: { message?: string };
      choices?: { message?: { content?: string } }[];
      data?: { url?: string }[];
      relay?: { accountEmail?: string };
    };
    if (!res.ok) return { ok: false as const, error: body.error?.message || `网关 ${res.status}` };
    if (kind === "chat") {
      const text = body.choices?.[0]?.message?.content;
      if (!text) return { ok: false as const, error: "空回复" };
      return { ok: true as const, text, email: body.relay?.accountEmail };
    }
    const url = body.data?.[0]?.url;
    if (!url) return { ok: false as const, error: "未返回图片" };
    return { ok: true as const, url, email: body.relay?.accountEmail };
  }

  function pushStep(label: string, state: Step["state"]) {
    setSteps((s) => {
      const next: Step[] = s.map((x) => (x.state === "run" ? { ...x, state: "ok" } : x));
      return [...next, { label, state }];
    });
  }

  async function send() {
    const platform: Platform = mode === "chat" ? "chatgpt" : "gemini";
    if (!prompt.trim()) {
      toast.error("请输入内容");
      return;
    }
    setBusy(true);
    setReply("");
    setImageUrl("");
    setUsed("");
    setSwitched(0);
    setSteps([]);
    const started = performance.now();
    const model = mode === "chat" ? "gpt-4o" : "gemini-image";

    try {
      if (forceFailFirst) {
        const account = pickHealthy(platform);
        if (account) {
          markAccountUsed(account.id, false, settings.failThreshold, "模拟网页超时");
          addLog({
            model,
            platform,
            accountId: account.id,
            accountEmail: account.email,
            latencyMs: 40,
            status: "switched",
            detail: "模拟失败，切换下一健康号",
            promptPreview: prompt.slice(0, 80),
          });
          setSwitched(1);
          pushStep(`${account.email} 失败，换号`, "fail");
        }
      }

      pushStep("提交网关任务，等待执行器回写", "run");
      const res =
        mode === "chat" ? await runViaApi("chat", prompt.trim()) : await runViaApi("image", prompt.trim());
      const latency = Math.round(performance.now() - started);
      const email = ("email" in res && res.email) || "";
      if (!res.ok) {
        addLog({
          model,
          platform,
          accountId: null,
          accountEmail: email || "—",
          latencyMs: latency,
          status: "fail",
          detail: res.error,
          promptPreview: prompt.slice(0, 80),
        });
        pushStep(res.error, "fail");
        toast.error(res.error);
        return;
      }
      addLog({
        model,
        platform,
        accountId: null,
        accountEmail: email || "—",
        latencyMs: latency,
        status: "success",
        detail: "完成",
        promptPreview: prompt.slice(0, 80),
      });
      pushStep("网关返回完成", "ok");
      if ("text" in res && res.text) setReply(res.text);
      if ("url" in res && res.url) setImageUrl(res.url);
      setUsed(email);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight">网关试运行</h1>
        <p className="mt-2 text-sm text-muted">
          对话和出图都走同一条网关：任务队列 → 执行器回写。点发送即可验证。
        </p>
      </header>

      <div className="flex gap-2">
        <Button variant={mode === "chat" ? "default" : "secondary"} onClick={() => setMode("chat")}>
          /v1/chat/completions
        </Button>
        <Button variant={mode === "image" ? "default" : "secondary"} onClick={() => setMode("image")}>
          /v1/images/generations
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="font-mono text-xs text-muted">
          POST {mode === "chat" ? "/v1/chat/completions" : "/v1/images/generations"}
        </p>
        <Textarea className="mt-4 min-h-32" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <label className="mt-4 flex min-h-11 items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={liveWeb && mode === "chat"}
            disabled={mode !== "chat"}
            onChange={(e) => setLiveWeb(e.target.checked)}
          />
          ChatGPT 真网页（本机 Worker 打开 chatgpt.com）
        </label>
        {mode === "chat" && liveWeb && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className={workerOn ? "text-muted" : "text-danger"}>
              执行器：{workerOn === null ? "检测中" : workerOn ? "在线" : "未启动"}
            </span>
            <Button variant="secondary" size="sm" type="button" onClick={() => void downloadWorker()}>
              下载本机 Worker
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={() => void pingWorker()}>
              重新检测
            </Button>
          </div>
        )}
        <label className="flex min-h-11 items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={forceFailFirst}
            onChange={(e) => setForceFailFirst(e.target.checked)}
          />
          模拟首号失败并自动切换
        </label>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-subtle">点发送走网关任务队列。</p>
          <Button type="button" onClick={() => void send()} disabled={busy}>
            {busy ? "调度中…" : "发送"}
          </Button>
        </div>
      </div>

      {steps.length > 0 && (
        <ol className="space-y-2 rounded-xl border border-border bg-surface p-5 text-sm">
          {steps.map((s, i) => (
            <li key={`${s.label}-${i}`} className="flex items-start gap-2">
              <Badge tone={s.state === "fail" ? "danger" : s.state === "run" ? "warn" : "ok"}>
                {s.state === "run" ? "进行" : s.state === "fail" ? "失败" : "完成"}
              </Badge>
              <span className="text-muted">{s.label}</span>
            </li>
          ))}
        </ol>
      )}

      {(reply || imageUrl || used) && (
        <div className="rounded-xl border border-border bg-surface p-5">
          {used && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone="ok">已路由</Badge>
              <span className="font-mono text-xs text-muted">{used}</span>
              {switched > 0 && <Badge tone="warn">换号 {switched} 次</Badge>}
            </div>
          )}
          {reply && <p className="whitespace-pre-wrap text-sm leading-relaxed">{reply}</p>}
          {imageUrl && (
            <img src={imageUrl} alt="生成结果" className="mt-2 max-h-96 w-full rounded-md object-contain" />
          )}
        </div>
      )}
    </div>
  );
}
