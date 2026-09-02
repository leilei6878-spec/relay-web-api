import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { ImageInput } from "@/components/image-input";
import { ASPECT_PRESETS, resolutionOptionsFor, type ImageAspect, type ImageK } from "@/lib/provider/image-size";
import { invokeTimeoutMessage } from "@/lib/image-timeout";
import {
  historyBadgeOk,
  phaseFromLogical,
  readSse,
  type LogicalStatus,
} from "@/lib/sse-client";

export const Route = createFileRoute("/console")({ component: Page });

const CHAT_MODELS = [
  { id: "chatgpt-web-auto", label: "ChatGPT 网页默认（实际模型未验证）" },
  { id: "gpt-5.6", label: "GPT-5.6（网页明确显示版本时）" },
  { id: "gpt-5", label: "GPT-5 Auto" },
  { id: "gpt-5-thinking", label: "GPT-5 Thinking" },
  { id: "gpt-4o", label: "GPT-4o" },
];

const IMAGE_MODELS = [
  { id: "leonardo-gemini", label: "Leonardo / Nano Banana 2" },
  { id: "leonardo-gpt-image-2", label: "Leonardo / GPT Image 2" },
  { id: "gemini-image", label: "Gemini / 出图" },
];

const MAX_PROMPT_CHARS = 21_000;
type Phase = "idle" | "sending" | "streaming" | "done" | "error";
type Kind = "chat" | "image";
type HistoryItem = {
  id: string;
  at: string;
  kind: Kind;
  model: string;
  prompt: string;
  status: number;
  logicalStatus: LogicalStatus;
  latencyMs: number;
  content: string;
  errorMessage: string;
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
  const [model, setModel] = useState("chatgpt-web-auto");
  const [imageModel, setImageModel] = useState("leonardo-gemini");
  const [imageN, setImageN] = useState(1);
  const [imageAspect, setImageAspect] = useState<ImageAspect>("16:9");
  const [imageK, setImageK] = useState<ImageK>("1K");
  const [imageQuality, setImageQuality] = useState("MEDIUM");
  const resolutions = resolutionOptionsFor(imageModel, imageAspect);
  const imageSize = (resolutions.find((r) => r.k === imageK) || resolutions[0])?.size || "1376x768";
  const showQuality = imageModel.includes("gpt-image") || imageModel.startsWith("dall-e");
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState("你好，你是什么模型？用三句话说明。");
  const [images, setImages] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<number | null>(null);
  const [logicalStatus, setLogicalStatus] = useState<LogicalStatus | null>(null);
  const [content, setContent] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [account, setAccount] = useState("");
  const [mode, setMode] = useState("");
  const [step, setStep] = useState("");
  const [rawReq, setRawReq] = useState("");
  const [rawRes, setRawRes] = useState("");
  const [tab, setTab] = useState<"result" | "request" | "response">("result");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [workerOnline, setWorkerOnline] = useState<boolean | null>(null);
  const [poolNote, setPoolNote] = useState("");
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
    const load = () =>
      fetch("/api/admin/plane", { credentials: "include" })
        .then(
          (r) =>
            r.json() as Promise<{
              accounts?: { platform?: string; status?: string; email?: string; lastError?: string | null }[];
            }>,
        )
        .then((b) => {
          const need = imageModel === "gemini-image" ? "gemini" : "leonardo";
          const mine = (b.accounts || []).filter((a) => a.platform === need);
          const ok = mine.filter((a) => a.status === "healthy" || a.status === "probing");
          if (ok.length) {
            setPoolNote("");
            return;
          }
          const row = mine[0];
          const why = row?.lastError || row?.status || "未添加";
          const label = need === "gemini" ? "Gemini" : "Leonardo";
          setPoolNote(
            `${label} 网页号不可用（${row?.email || "无账号"}：${why}）。现在发出去会立刻失败，请先到「账号池」完成登录后再测图生图。`,
          );
        })
        .catch(() => setPoolNote(""));
    void load();
  }, [imageModel]);

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
        n: imageN,
        size: imageSize,
        aspect_ratio: imageAspect,
        image_size: imageK,
        ...(imageModel.includes("gpt-image") ? { quality: imageQuality } : {}),
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
  }, [kind, model, imageModel, imageN, imageSize, imageAspect, imageK, imageQuality, prompt, images]);

  async function run() {
    if (!prompt.trim() && images.length === 0) {
      toast.error("请输入内容或添加图片");
      return;
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      toast.error(`内容超过 ${MAX_PROMPT_CHARS} 字，请删减后再发`);
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    started.current = Date.now();
    setElapsed(0);
    setPhase("sending");
    setStatus(null);
    setLogicalStatus(null);
    setContent("");
    setErrorMessage("");
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
          if (meta.replace && delta) setContent(delta);
          else if (delta) setContent((c) => c + delta);
          if (meta.accountEmail) setAccount(meta.accountEmail);
          if (meta.mode) setMode(meta.mode);
          if (meta.phase) setStep(meta.phase);
        });
        const latencyMs = Date.now() - started.current;
        setElapsed(latencyMs);
        const err = assembled.error?.message || "";
        const logical = assembled.logicalStatus;
        const finalJson = {
          id: assembled.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: assembled.text || assembled.partialText || "" },
              finish_reason: assembled.finishReason || (logical === "success" ? "stop" : logical),
            },
          ],
          relay: {
            accountEmail: assembled.accountEmail,
            mode: assembled.mode,
            jobId: assembled.jobId || assembled.id,
            logicalStatus: logical,
            transportStatus: assembled.transportStatus,
            completed: assembled.completed,
            requested_model: assembled.requestedModel,
            actual_model: assembled.actualModel,
            actual_model_label: assembled.actualModelLabel,
            model_verified: assembled.modelVerified,
            requested_profile: assembled.requestedProfile,
            actual_profile: assembled.actualProfile,
            profile_verified: assembled.profileVerified,
          },
          ...(assembled.error ? { error: assembled.error } : {}),
        };
        setRawRes(JSON.stringify(finalJson, null, 2));
        setContent(assembled.text || assembled.partialText || "");
        setErrorMessage(err);
        setLogicalStatus(logical);
        setPhase(phaseFromLogical(logical));
        if (logical !== "success") {
          toast.error(err || `业务失败 · SSE HTTP ${res.status}`);
        }
        pushHistory({
          id: assembled.id || String(Date.now()),
          at: new Date().toISOString(),
          kind,
          model,
          prompt: prompt.trim(),
          status: res.status,
          logicalStatus: logical,
          latencyMs,
          content: assembled.text || assembled.partialText || "",
          errorMessage: err,
          imageUrl: "",
          mode: assembled.mode,
          account: assembled.accountEmail,
          raw: finalJson,
        });
        return;
      }
      const rawText = await res.text();
      let json: {
        error?: { message?: string };
        choices?: { message?: { content?: string } }[];
        data?: { url?: string; b64_json?: string }[];
        relay?: { accountEmail?: string; mode?: string; size?: string };
      } = {};
      if (!rawText.trim()) {
        json = {
          error: {
            message:
              res.status === 504
                ? invokeTimeoutMessage(endpoint, body)
                : `HTTP ${res.status || 0}：空响应`,
          },
        };
      } else {
        try {
          json = JSON.parse(rawText) as typeof json;
        } catch {
          json = {
            error: {
              message: `HTTP ${res.status}：响应不是 JSON（${rawText.slice(0, 120) || "empty"}）`,
            },
          };
        }
      }
      const latencyMs = Date.now() - started.current;
      setElapsed(latencyMs);
      setRawRes(rawText.trim() ? rawText : JSON.stringify(json, null, 2));
      setAccount(json.relay?.accountEmail || "");
      setMode(json.relay?.mode || "");
      if (!res.ok || json.error) {
        setPhase("error");
        setLogicalStatus("error");
        setContent(json.choices?.[0]?.message?.content || "");
        setErrorMessage(json.error?.message || `HTTP ${res.status}`);
        toast.error(json.error?.message || `HTTP ${res.status}`);
      } else if (kind === "image") {
        const first = json.data?.[0];
        const url = first?.url || (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : "");
        setImageUrl(url);
        setLogicalStatus(url ? "success" : "error");
        setPhase(url ? "done" : "error");
        if (!url) {
          setErrorMessage("未返回图片");
          toast.error("未返回图片");
        }
      } else {
        const text = json.choices?.[0]?.message?.content || "";
        setContent(text);
        setLogicalStatus(text ? "success" : "error");
        setPhase(text ? "done" : "error");
        if (!text) setErrorMessage("空响应");
      }
      const first = json.data?.[0];
      const histUrl = first?.url || (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : "");
      const jsonLogical: LogicalStatus =
        !res.ok || json.error ? "error" : histUrl || json.choices?.[0]?.message?.content ? "success" : "error";
      pushHistory({
        id: String(Date.now()),
        at: new Date().toISOString(),
        kind,
        model: kind === "chat" ? model : imageModel,
        prompt: prompt.trim(),
        status: res.status,
        logicalStatus: jsonLogical,
        latencyMs,
        content: json.choices?.[0]?.message?.content || "",
        errorMessage: json.error?.message || "",
        imageUrl: histUrl,
        mode: json.relay?.mode,
        account: json.relay?.accountEmail,
        raw: json,
      });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        setPhase("error");
        setLogicalStatus("cancelled");
        setErrorMessage("已停止");
        setContent((c) => c);
        return;
      }
      setPhase("error");
      setLogicalStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "请求失败");
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
          ? "成功"
          : phase === "error"
            ? logicalStatus === "uncertain"
              ? "业务不确定"
              : logicalStatus === "cancelled"
                ? "已取消"
                : "业务失败"
            : "待发送";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight">API 实时测试 · 比例 + 分辨率</h1>
        <p className="mt-2 text-sm text-muted">
          先选比例，再选 Small / Medium / Large。16:9 Small 是 1376×768，不是方图。参考图必须出现缩略图后才会出图。
        </p>
      </header>
      {workerOnline === false && (
        <p className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-danger">
          服务器执行器离线，正在自动拉起。请稍后再发一次。
        </p>
      )}
      {kind === "image" && poolNote && (
        <p className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-danger">{poolNote}</p>
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
          {kind === "image" && (
            <>
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-muted">比例（必选）· Facebook 16:9 / Twitter 4:3 / Instagram 4:5 / TikTok 9:16 / Ultrawide 21:9</span>
                <select
                  className="h-11 w-full rounded-sm border border-border bg-elevated px-3 text-sm"
                  value={imageAspect}
                  onChange={(e) => setImageAspect(e.target.value as ImageAspect)}
                >
                  {ASPECT_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.hint ? `${p.label} · ${p.hint}` : p.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="block text-sm">
                <span className="mb-1 block text-xs text-muted">分辨率（必选）· 选比例后再选 Small / Medium / Large</span>
                <div className="grid grid-cols-3 gap-2">
                  {resolutions.map((r) => (
                    <button
                      key={r.k}
                      type="button"
                      onClick={() => setImageK(r.k)}
                      className={`rounded-sm border px-2 py-2 text-center ${
                        imageK === r.k ? "border-accent bg-elevated" : "border-border bg-elevated/60"
                      }`}
                    >
                      <span className="block text-sm">{r.tier}</span>
                      <span className="mt-0.5 block font-mono text-[11px] text-muted">
                        {r.w}×{r.h}
                      </span>
                    </button>
                  ))}
                </div>
                <span className="mt-1 block font-mono text-[11px] text-subtle">
                  当前 {imageAspect} · {imageK} · {imageSize.replace("x", "×")}
                </span>
              </div>
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-muted">张数</span>
                <select
                  className="h-11 w-full rounded-sm border border-border bg-elevated px-3 text-sm"
                  value={imageN}
                  onChange={(e) => setImageN(Number(e.target.value))}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n} 张
                    </option>
                  ))}
                </select>
              </label>
              {showQuality && (
                <label className="block text-sm">
                  <span className="mb-1 block text-xs text-muted">画质</span>
                  <select
                    className="h-11 w-full rounded-sm border border-border bg-elevated px-3 text-sm"
                    value={imageQuality}
                    onChange={(e) => setImageQuality(e.target.value)}
                  >
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                  </select>
                </label>
              )}
            </>
          )}
          <label className="block text-sm">
            <span className="mb-1 flex items-center justify-between gap-2 text-xs text-muted">
              <span>内容</span>
              <span className={`font-mono tabular-nums ${prompt.length >= MAX_PROMPT_CHARS ? "text-danger" : "text-subtle"}`}>
                {prompt.length} / {MAX_PROMPT_CHARS}
              </span>
            </span>
            <Textarea
              className="min-h-32"
              value={prompt}
              maxLength={MAX_PROMPT_CHARS}
              onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT_CHARS))}
            />
          </label>
          <ImageInput
            images={images}
            onChange={setImages}
            hint={kind === "chat" ? "对话识图，OpenAI Vision 格式" : "参考图写入 image / images（Leonardo 最多 6 张）。未出现缩略图不会出图。"}
            max={kind === "image" ? 6 : 4}
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
            {status != null && <Badge>SSE HTTP {status}</Badge>}
            {errorMessage && (
              <Badge tone="danger">{errorMessage.split(":")[0].slice(0, 40)}</Badge>
            )}
            <span className="font-mono text-xs tabular-nums text-muted">{(elapsed / 1000).toFixed(2)}s</span>
            {account && <span className="font-mono text-[11px] text-subtle">{account}</span>}
            {step && <span className="text-[11px] text-muted">{stepLabel(step)}</span>}
            {mode && (
              <Badge tone={mode === "live" || mode === "web_account" ? "ok" : "warn"}>
                {mode === "live" || mode === "web_account" ? "真网页 Worker" : mode === "preview" ? "预览回写" : mode}
              </Badge>
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
                  {content && phase === "error" && (
                    <p className="mb-1 text-[11px] uppercase tracking-wide text-subtle">部分输出</p>
                  )}
                  {content && <p className="whitespace-pre-wrap text-sm leading-relaxed">{content}</p>}
                  {errorMessage && (
                    <div className="mt-4 rounded-md border border-danger/30 bg-danger/5 p-3">
                      <p className="text-[11px] uppercase tracking-wide text-danger">错误</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-danger">{errorMessage}</p>
                      {status != null && (
                        <p className="mt-2 text-[11px] text-subtle">传输层 SSE HTTP {status}，不代表业务成功。</p>
                      )}
                    </div>
                  )}
                  {imageUrl && (
                    <>
                      <img src={imageUrl} alt="生成结果" className="mt-3 max-h-96 w-full rounded-md object-contain" />
                      {kind === "image" && (
                        <p className="mt-2 font-mono text-[11px] text-subtle">
                          请求 {imageAspect} · {imageK} · {imageSize.replace("x", "×")}。横图不应是方图。
                        </p>
                      )}
                    </>
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
                  <Badge tone={historyBadgeOk(h.logicalStatus) ? "ok" : "danger"}>
                    {historyBadgeOk(h.logicalStatus) ? "成功" : "失败"} · HTTP {h.status}
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
                      setErrorMessage(h.errorMessage || "");
                      setImageUrl(h.imageUrl);
                      setAccount(h.account || "");
                      setMode(h.mode || "");
                      setStatus(h.status);
                      setLogicalStatus(h.logicalStatus);
                      setElapsed(h.latencyMs);
                      setRawRes(JSON.stringify(h.raw, null, 2));
                      setPhase(phaseFromLogical(h.logicalStatus));
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
