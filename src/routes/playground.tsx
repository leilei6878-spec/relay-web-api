import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { ImageInput } from "@/components/image-input";
import { invokeTimeoutMessage } from "@/lib/image-timeout";
import { getApiKey, readSessionFile } from "@/lib/gateway";
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

const CHAT_MODELS = [
  { id: "chatgpt-web-auto", label: "ChatGPT 网页默认（实际模型未验证）" },
  { id: "gpt-5.6", label: "GPT-5.6（网页明确显示版本时）" },
  { id: "gpt-5", label: "GPT-5 Auto" },
  { id: "gpt-5-thinking", label: "GPT-5 Thinking" },
  { id: "gpt-4o", label: "GPT-4o" },
];

const IMAGE_MODELS = [
  { id: "gemini-image", label: "Gemini / 出图" },
  { id: "leonardo-gpt-image-2", label: "Leonardo / GPT Image 2" },
  { id: "leonardo-gemini", label: "Leonardo / Nano Banana 2" },
];

function Playground() {
  const [mode, setMode] = useState<"chat" | "image">("chat");
  const [prompt, setPrompt] = useState("用三句话说明为什么账号必须绑定 sticky IP。");
  const [images, setImages] = useState<string[]>([]);
  const [reply, setReply] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [used, setUsed] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [forceFailFirst, setForceFailFirst] = useState(false);
  const [liveWeb, setLiveWeb] = useState(true);
  const [chatModel, setChatModel] = useState("chatgpt-web-auto");
  const [imageModel, setImageModel] = useState("gemini-image");
  const [switched, setSwitched] = useState(0);
  const [workerOn, setWorkerOn] = useState<boolean | null>(null);
  const [replySource, setReplySource] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const pickHealthy = useGateway((s) => s.pickHealthy);
  const markAccountUsed = useGateway((s) => s.markAccountUsed);
  const addLog = useGateway((s) => s.addLog);
  const settings = useGateway((s) => s.settings);

  useEffect(() => {
    void pingWorker();
    void getApiKey().then((r) => setApiKey(r.apiKey));
    const t = setInterval(() => void pingWorker(), 4000);
    return () => clearInterval(t);
  }, []);

  async function pingWorker() {
    try {
      const res = await fetch(`${LOCAL_WORKER}/health`, { signal: AbortSignal.timeout(1500) });
      const body = (await res.json()) as { ok?: boolean; mode?: string };
      setWorkerOn(Boolean(body.ok));
      return Boolean(body.ok);
    } catch {
      setWorkerOn(false);
      return false;
    }
  }

  async function downloadWorker() {
    const kit = await fetch("/api/admin/worker-kit", { credentials: "include" }).then(
      (r) => r.json() as Promise<{ workerToken?: string; gateway?: string }>,
    );
    const origin = kit.gateway || window.location.origin;
    const token = kit.workerToken || "";
    const bat = `@echo off
cd /d "%~dp0"
set RELAY_GATEWAY=${origin}
set RELAY_TOKEN=${token}
set RELAY_WORKER_NAME=pc-1
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
        data: textFile("Keep v2rayN on. RELAY_TOKEN is the worker credential, not a customer API key.\n"),
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
    const payload =
      kind === "chat"
        ? {
            model: chatModel,
            messages: [
              {
                role: "user",
                content:
                  images.length === 0
                    ? promptText
                    : [
                        { type: "text", text: promptText || "请描述这张图片" },
                        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
                      ],
              },
            ],
          }
        : { prompt: promptText, model: imageModel, ...(images[0] ? { image: images[0], images } : {}) };
    const res = await fetch("/api/admin/invoke", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: kind === "chat" ? "/v1/chat/completions" : "/v1/images/generations",
        payload,
      }),
    });
    const rawText = await res.text();
    let body: {
      error?: { message?: string };
      choices?: { message?: { content?: string } }[];
      data?: { url?: string }[];
      relay?: { accountEmail?: string; mode?: string };
    } = {};
    if (!rawText.trim()) {
      return {
        ok: false as const,
        error:
          res.status === 504
            ? invokeTimeoutMessage(kind === "chat" ? "/v1/chat/completions" : "/v1/images/generations", payload)
            : `网关 ${res.status || 0}：空响应`,
      };
    }
    try {
      body = JSON.parse(rawText) as typeof body;
    } catch {
      return { ok: false as const, error: `HTTP ${res.status}：响应不是 JSON` };
    }
    if (!res.ok) return { ok: false as const, error: body.error?.message || `网关 ${res.status}` };
    if (kind === "chat") {
      const text = body.choices?.[0]?.message?.content;
      if (!text) return { ok: false as const, error: "空回复" };
      return { ok: true as const, text, email: body.relay?.accountEmail, mode: body.relay?.mode };
    }
    const url = body.data?.[0]?.url;
    if (!url) return { ok: false as const, error: "未返回图片" };
    return { ok: true as const, url, email: body.relay?.accountEmail, mode: body.relay?.mode };
  }

  async function runLocalChat(promptText: string, model: string) {
    const up = await pingWorker();
    if (!up) {
      return { ok: false as const, error: "本机 Worker 未启动。请下载并运行，同时打开 v2rayN 同一条节点。" };
    }
    const account = pickHealthy("chatgpt");
    if (!account) return { ok: false as const, error: "没有已登录且绑定代理的 ChatGPT 账号" };
    const session = await readSessionFile({ data: { accountId: account.id } });
    if (!session.ok) return { ok: false as const, error: session.error };
    const res = await fetch(`${LOCAL_WORKER}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: promptText,
        model,
        images,
        storageState: JSON.parse(session.json),
        timeoutMs: settings.replyTimeoutMs,
      }),
    });
    const body = (await res.json()) as { ok?: boolean; text?: string; error?: string };
    if (!body.ok || !body.text) return { ok: false as const, error: body.error || "本机 Worker 没有返回 ChatGPT 回复" };
    if (body.text.startsWith("MOCK:")) {
      return { ok: false as const, error: "当前 Worker 仍是测试模式。请重新下载本机 Worker 后再发。" };
    }
    return { ok: true as const, text: body.text, email: account.email };
  }

  function pushStep(label: string, state: Step["state"]) {
    setSteps((s) => {
      const next: Step[] = s.map((x) => (x.state === "run" ? { ...x, state: "ok" } : x));
      return [...next, { label, state }];
    });
  }

  async function send() {
    const platform: Platform = mode === "chat" ? "chatgpt" : imageModel.startsWith("leonardo-") ? "leonardo" : "gemini";
    const promptText =
      prompt.trim() || (images.length ? (mode === "chat" ? "请描述这张图片" : "根据参考图生成一张新图") : "");
    if (!promptText) {
      toast.error("请输入内容或添加图片");
      return;
    }
    setBusy(true);
    setReply("");
    setImageUrl("");
    setUsed("");
    setReplySource("");
    setSwitched(0);
    setSteps([]);
    const started = performance.now();
    const model = mode === "chat" ? chatModel : imageModel;

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

      pushStep("交给服务器执行器", "run");
      const res = await runViaApi(mode === "chat" ? "chat" : "image", promptText);
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
      setReplySource(res.ok && "mode" in res && res.mode === "live" ? "web" : res.ok ? "preview" : "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight">试运行</h1>
        <p className="mt-2 text-sm text-muted">
          正式调用走服务器执行器，按账号代理打开网页。下面的下载包只给「第一次在电脑登录」用，不是给每个用户装的。
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
        <div className="mt-3">
          <ImageInput
            images={images}
            onChange={setImages}
            hint={mode === "chat" ? "对话识图" : imageModel.startsWith("leonardo-") ? "Leonardo 参考图最多 6 张" : "出图参考图"}
            max={mode === "image" && imageModel.startsWith("leonardo-") ? 6 : 4}
          />
        </div>
        {mode === "chat" && (
          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-xs text-muted">模型</span>
            <select
              className="h-11 w-full rounded-sm border border-border bg-elevated px-3 text-sm"
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
            >
              {CHAT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {mode === "image" && (
          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-xs text-muted">模型</span>
            <select
              className="h-11 w-full rounded-sm border border-border bg-elevated px-3 text-sm"
              value={imageModel}
              onChange={(e) => setImageModel(e.target.value)}
            >
              {IMAGE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="mt-4 text-xs text-subtle">
          请求走 /v1，由服务器执行器打开网页。登录包在账号池下载，不必给每个调用方装软件。
        </p>
        {showAdvanced && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => void downloadWorker()}>
              备用：其它机器执行器
            </Button>
          </div>
        )}
        <label className="flex min-h-11 items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
          显示高级选项
        </label>
        {showAdvanced && (
          <label className="flex min-h-11 items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={forceFailFirst}
              onChange={(e) => setForceFailFirst(e.target.checked)}
            />
            模拟首号失败并自动切换
          </label>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-subtle">走开放 API。服务器执行器在线才会返回网页原文。</p>
          <Button type="button" onClick={() => void send()} disabled={busy || (mode === "chat" && liveWeb && !workerOn)}>
            {busy ? "发送中…" : "发送"}
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
              <Badge tone={replySource === "web" ? "ok" : "warn"}>
                {replySource === "web" ? "ChatGPT 网页原文" : "预览回写"}
              </Badge>
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

      <CurlCard apiKey={apiKey} model={chatModel} />
    </div>
  );
}

function CurlCard({ apiKey, model }: { apiKey: string; model: string }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const curl = `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${apiKey || "你的密钥"}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}]}'`;
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <p className="text-sm font-medium">给其他程序调用</p>
      <p className="mt-1 text-xs text-subtle">
        服务器执行器在线时返回网页原文；离线则 503。不必在调用方电脑装 Worker。
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md bg-elevated p-3 font-mono text-[11px] leading-relaxed text-muted">
        {curl}
      </pre>
      <Button
        className="mt-3"
        variant="secondary"
        size="sm"
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(curl);
          toast.success("已复制 curl");
        }}
      >
        复制
      </Button>
    </div>
  );
}
