import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { ImageInput } from "@/components/image-input";

export const Route = createFileRoute("/console")({ component: Page });

const CHAT_MODELS = [
  { id: "gpt-5.6", label: "GPT-5.6 最新" },
  { id: "gpt-5", label: "GPT-5 Auto" },
  { id: "gpt-5-thinking", label: "GPT-5 Thinking" },
  { id: "gpt-4o", label: "GPT-4o" },
];

const IMAGE_MODELS = [
  { id: "gemini-image", label: "Gemini / 出图" },
  { id: "leonardo-gpt-image-2", label: "Leonardo / GPT Image 2" },
  { id: "leonardo-gemini", label: "Leonardo / Gemini" },
];

type Phase = "idle" | "sending" | "streaming" | "done" | "error";
type Kind = "chat" | "image";
type HistoryItem = {
  id: string;
  at: string;
  kind: Kind;
  model: string;
  prompt: string;
  status: number;
  latencyMs: number;
  content: string;
  imageUrl: string;
  mode?: string;
  account?: string;
  raw: unknown;
};

function Page() {
  return (
    <AppShell>
      <Console />
    </AppShell>
  );
}

function Console() {
  const [kind, setKind] = useState<Kind>("chat");
  const [model, setModel] = useState("gpt-5.6");
  const [imageModel, setImageModel] = useState("gemini-image");
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState("你好，你是什么模型？用三句话说明。");
  const [images, setImages] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<number | null>(null);
  const [content, setContent] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [account, setAccount] = useState("");
  const [mode, setMode] = useState("");
  const [step, setStep] = useState("");
  const [rawReq, setRawReq] = useState("");
  const [rawRes, setRawRes] = useState("");
  const [tab, setTab] = useState<"result" | "request" | "response">("result");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [workerOnline, setWorkerOnline] = useState<boolean | null>(null);
  const started = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ping = () =>
      fetch("/api/runtime")
        .then((r) => r.json() as Promise<{ workerOnline?: boolean }>)
        .then((b) => setWorkerOnline(Boolean(b.workerOnline)))
        .catch(() => setWorkerOnline(false));
    void ping();
    const t = setInterval(ping, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (phase !== "sending" && phase !== "streaming") return;
    const t = setInterval(() => setElapsed(Date.now() - started.current), 80);
    return () => clearInterval(t);
  }, [phase]);

  const endpoint = kind === "chat" ? "/v1/chat/completions" : "/v1/images/generations";
  const body = useMemo(() => {
    if (kind === "image") {
      return {
        prompt,
        model: imageModel,
        ...(images[0] ? { image: images[0], images } : {}),
      };
    }
    const content =
      images.length === 0
        ? prompt
        : [
            { type: "text", text: prompt || "请描述这张图片" },
            ...images.map((url) => ({ type: "image_url", image_url: { url } })),
          ];
    return { model, stream: true, messages: [{ role: "user", content }] };
  }, [kind, model, imageModel, prompt, images]);

  async function run() {
    if (!prompt.trim() && images.length === 0) {
      toast.error("请输入内容或添加图片");
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    started.current = Date.now();
    setElapsed(0);
    setPhase("sending");
    setStatus(null);
    setContent("");
    setImageUrl("");
    setAccount("");
    setMode("");
    setStep("");
    setTab("result");
    const reqText = JSON.stringify(body, null, 2);
    setRawReq(reqText);
    setRawRes("");
    try {
      const res = apiKey.trim()
        ? await fetch(endpoint, {
            method: "POST",
            signal: ac.signal,
            credentials: "omit",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey.trim()}`,
            },
            body: JSON.stringify(body),
          })
        : await fetch("/api/admin/invoke", {
            method: "POST",
            signal: ac.signal,
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: endpoint, payload: body }),
          });
      setStatus(res.status);
      const ctype = res.headers.get("content-type") || "";
      if (kind === "chat" && ctype.includes("text/event-stream")) {
        setPhase("streaming");
        const assembled = await readSse(res, (delta, meta) => {
          if (delta) setContent((c) => c + delta);
          if (meta.accountEmail) setAccount(meta.accountEmail);
          if (meta.mode) setMode(meta.mode);
          if (meta.phase) setStep(meta.phase);
        });
        const latencyMs = Date.now() - started.current;
        setElapsed(latencyMs);
        const finalJson = {
          id: assembled.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: assembled.text || "" },
              finish_reason: "stop",
            },
          ],
          relay: {
            accountEmail: assembled.accountEmail,
            mode: assembled.mode,
            jobId: assembled.id,
          },
          ...(assembled.error ? { error: assembled.error } : {}),
        };
        setRawRes(JSON.stringify(finalJson, null, 2));
        setContent(assembled.text || assembled.error?.message || "");
        const err = assembled.error?.message;
        if (!res.ok || err) {
          setPhase("error");
          toast.error(err || `HTTP ${res.status}`);
        } else {
          setPhase("done");
        }
        pushHistory({
          id: assembled.id || String(Date.now()),
          at: new Date().toISOString(),
          kind,
          model,
          prompt: prompt.trim(),
          status: res.status,
          latencyMs,
          content: assembled.text || err || "",
          imageUrl: "",
          mode: assembled.mode,
          account: assembled.accountEmail,
          raw: finalJson,
        });
        return;
      }
      const json = (await res.json()) as {
        error?: { message?: string };
        choices?: { message?: { content?: string } }[];
        data?: { url?: string }[];
        relay?: { accountEmail?: string; mode?: string };
      };
      const latencyMs = Date.now() - started.current;
      setElapsed(latencyMs);
      setRawRes(JSON.stringify(json, null, 2));
      setAccount(json.relay?.accountEmail || "");
      setMode(json.relay?.mode || "");
      if (!res.ok) {
        setPhase("error");
        setContent(json.error?.message || `HTTP ${res.status}`);
        toast.error(json.error?.message || `HTTP ${res.status}`);
      } else if (kind === "image") {
        const url = json.data?.[0]?.url || "";
        setImageUrl(url);
        setPhase(url ? "done" : "error");
        if (!url) toast.error("未返回图片");
      } else {
        const text = json.choices?.[0]?.message?.content || "";
        setContent(text);
        setPhase(text ? "done" : "error");
      }
      pushHistory({
        id: String(Date.now()),
        at: new Date().toISOString(),
        kind,
        model: kind === "chat" ? model : imageModel,
        prompt: prompt.trim(),
        status: res.status,
        latencyMs,
        content: json.choices?.[0]?.message?.content || json.error?.message || "",
        imageUrl: json.data?.[0]?.url || "",
        mode: json.relay?.mode,
        account: json.relay?.accountEmail,
        raw: json,
      });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setPhase("error");
      setContent(err instanceof Error ? err.message : "请求失败");
      toast.error("请求失败");
    }
  }

  function pushHistory(item: HistoryItem) {
    setHistory((h) => [item, ...h].slice(0, 12));
  }

  const phaseLabel =
    phase === "sending"
      ? "已发出，等待网关"
      : phase === "streaming"
        ? "正在回写"
        : phase === "done"
          ? "完成"
          : phase === "error"
            ? "失败"
            : "待发送";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight">API 实时测试</h1>
        <p className="mt-2 text-sm text-muted">
          走正式开放接口。执行器默认在服务器上跑；离线时返回 503，不会换模型。
        </p>
      </header>
      {workerOnline === false && (
        <p className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-danger">
          服务器执行器离线，正在自动拉起。请稍后再发一次。
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
          <div className="flex gap-2">
            <Button variant={kind === "chat" ? "default" : "secondary"} type="button" onClick={() => setKind("chat")}>
              对话
            </Button>
            <Button variant={kind === "image" ? "default" : "secondary"} type="button" onClick={() => setKind("image")}>
              出图
            </Button>
          </div>
          <p className="font-mono text-[11px] text-subtle">POST {endpoint}</p>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted">API Key（可留空）</span>
            <Input
              className="font-mono text-xs"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="留空=用当前管理员登录测试正式接口"
            />
            <span className="mt-1 block text-[11px] text-subtle">
              后台已登录时不必填 Key。若填写客户 Key，将按开放 API 的鉴权发送。
            </span>
          </label>
          {kind === "chat" ? (
            <label className="block text-sm">
              <span className="mb-1 block text-xs text-muted">模型</span>
              <select
                className="h-11 w-full rounded-sm border border-border bg-elevated px-3 text-sm"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {CHAT_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="block text-sm">
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
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted">内容</span>
            <Textarea className="min-h-32" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <ImageInput
            images={images}
            onChange={setImages}
            hint={kind === "chat" ? "对话识图，OpenAI Vision 格式" : imageModel.startsWith("leonardo-") ? "Leonardo 参考图最多 6 张" : "出图参考图，写入 image / images"}
            max={kind === "image" && imageModel.startsWith("leonardo-") ? 6 : 4}
          />
          <div className="flex gap-2">
            <Button className="flex-1" type="button" onClick={() => void run()} disabled={phase === "sending" || phase === "streaming"}>
              {phase === "sending" || phase === "streaming" ? "测试中…" : "发送并查看结果"}
            </Button>
            {(phase === "sending" || phase === "streaming") && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => abortRef.current?.abort()}
              >
                停止
              </Button>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3">
            <Badge tone={phase === "done" ? "ok" : phase === "error" ? "danger" : phase === "idle" ? "default" : "warn"}>
              {phaseLabel}
            </Badge>
            {status != null && <Badge>HTTP {status}</Badge>}
            <span className="font-mono text-xs tabular-nums text-muted">{(elapsed / 1000).toFixed(2)}s</span>
            {account && <span className="font-mono text-[11px] text-subtle">{account}</span>}
            {step && <span className="text-[11px] text-muted">{stepLabel(step)}</span>}
            {mode && (
              <Badge tone={mode === "live" ? "ok" : "warn"}>{mode === "live" ? "真网页 Worker" : "预览回写"}</Badge>
            )}
          </div>

          <div className="rounded-xl border border-border bg-surface">
            <div className="flex gap-1 border-b border-border px-2 py-2">
              {(["result", "request", "response"] as const).map((t) => (
                <Button key={t} size="sm" variant={tab === t ? "default" : "ghost"} type="button" onClick={() => setTab(t)}>
                  {t === "result" ? "结果" : t === "request" ? "请求" : "响应 JSON"}
                </Button>
              ))}
              {tab !== "result" && (
                <Button
                  className="ml-auto"
                  size="sm"
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    const text = tab === "request" ? rawReq : rawRes;
                    void navigator.clipboard.writeText(text);
                    toast.success("已复制");
                  }}
                >
                  复制
                </Button>
              )}
            </div>
            <div className="min-h-64 p-5">
              {tab === "result" && (
                <div>
                  {phase === "idle" && <p className="text-sm text-muted">发送后，这里实时显示接口返回。</p>}
                  {content && <p className="whitespace-pre-wrap text-sm leading-relaxed">{content}</p>}
                  {imageUrl && (
                    <img src={imageUrl} alt="生成结果" className="mt-3 max-h-96 w-full rounded-md object-contain" />
                  )}
                  {!content && !imageUrl && phase === "sending" && (
                    <p className="text-sm text-muted">请求已发出…</p>
                  )}
                </div>
              )}
              {tab === "request" && (
                <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-muted">{rawReq || "—"}</pre>
              )}
              {tab === "response" && (
                <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-muted">{rawRes || "等待响应…"}</pre>
              )}
            </div>
          </div>
        </section>
      </div>

      {history.length > 0 && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-medium">本次测试记录</h2>
          <ul className="mt-3 divide-y divide-border">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{h.prompt}</p>
                  <p className="mt-1 text-[11px] text-subtle">
                    {h.kind === "chat" ? h.model : "出图"} · {h.account || "—"} · {h.latencyMs}ms
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={h.status >= 200 && h.status < 300 && (h.content || h.imageUrl) ? "ok" : "danger"}>
                    {h.status}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    onClick={() => {
                      setKind(h.kind);
                      setModel(h.kind === "chat" ? h.model : model);
                      setPrompt(h.prompt);
                      setContent(h.content);
                      setImageUrl(h.imageUrl);
                      setAccount(h.account || "");
                      setMode(h.mode || "");
                      setStatus(h.status);
                      setElapsed(h.latencyMs);
                      setRawRes(JSON.stringify(h.raw, null, 2));
                      setPhase(h.status >= 200 && h.status < 300 ? "done" : "error");
                      setTab("result");
                    }}
                  >
                    查看
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

async function readSse(
  res: Response,
  onDelta: (delta: string, meta: { accountEmail?: string; mode?: string; phase?: string }) => void,
) {
  const reader = res.body?.getReader();
  if (!reader) return { error: { message: "无法读取流" } } as { error?: { message?: string }; text?: string; id?: string; mode?: string; accountEmail?: string };
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let id = "";
  let mode = "";
  let accountEmail = "";
  let error: { message?: string } | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as {
          id?: string;
          error?: { message?: string };
          choices?: { delta?: { content?: string } }[];
          relay?: { accountEmail?: string; mode?: string; phase?: string };
        };
        if (json.id) id = json.id;
        if (json.relay?.accountEmail) accountEmail = json.relay.accountEmail;
        if (json.relay?.mode) mode = json.relay.mode;
        if (json.error?.message) error = json.error;
        const piece = json.choices?.[0]?.delta?.content || "";
        if (piece) {
          text += piece;
          onDelta(piece, { accountEmail, mode, phase: json.relay?.phase });
        } else {
          onDelta("", { accountEmail, mode, phase: json.relay?.phase });
        }
      } catch {
        /* skip malformed chunk */
      }
    }
  }
  return { id, text, mode, accountEmail, error };
}

function stepLabel(step: string) {
  return (
    {
      waiting_worker: "执行器处理中",
      opening_chatgpt: "正在打开 ChatGPT",
      page_ready: "页面已打开",
      composer_ready: "输入框就绪",
      generating: "等待模型回答",
      streaming: "正在输出",
    }[step] || step
  );
}
