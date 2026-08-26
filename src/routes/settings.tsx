import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { defaultSettings, useGateway } from "@/lib/store";
import type { SelectorPack } from "@/lib/types";

export const Route = createFileRoute("/settings")({ component: Page });

function Page() {
  return (
    <AppShell>
      <SettingsView />
    </AppShell>
  );
}

function SettingsView() {
  const settings = useGateway((s) => s.settings);
  const updateSettings = useGateway((s) => s.updateSettings);
  const resetDemo = useGateway((s) => s.resetDemo);

  function num(
    key:
      | "maxRetry"
      | "failThreshold"
      | "coolDownSeconds"
      | "intervalMinMs"
      | "intervalMaxMs"
      | "concurrencyPerWorker"
      | "replyTimeoutMs",
    value: string,
  ) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) updateSettings({ [key]: n });
  }

  function saveSelectors(which: "chatgptSelectors" | "geminiSelectors", raw: string) {
    try {
      const parsed = JSON.parse(raw) as SelectorPack;
      if (!parsed.input || !parsed.send) throw new Error("缺少 input/send");
      updateSettings({ [which]: parsed });
      toast.success("选择器已保存");
    } catch {
      toast.error("JSON 无效");
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-8">
      <header>
        <h1 className="text-2xl font-medium tracking-tight">API 与调度</h1>
        <p className="mt-2 text-sm text-muted">多 Key、限额、失败换号。Worker 不在线默认拒绝，不换模型充数。</p>
      </header>

      <ApiKeyCard />

      <div className="space-y-4 rounded-xl border border-border bg-surface p-5">
        <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
          <span>
            强制 sticky 代理
            <span className="mt-0.5 block text-[11px] text-subtle">无代理的号不能进入健康池</span>
          </span>
          <input
            type="checkbox"
            checked={settings.enforceProxy}
            onChange={(e) => updateSettings({ enforceProxy: e.target.checked })}
          />
        </label>
        <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
          <span>
            允许预览回写
            <span className="mt-0.5 block text-[11px] text-subtle">关闭后 Worker 不在线返回 503</span>
          </span>
          <input
            type="checkbox"
            checked={Boolean(settings.allowPreviewFallback)}
            onChange={(e) => updateSettings({ allowPreviewFallback: e.target.checked })}
          />
        </label>
        <Row label="单请求最大换号">
          <Input type="number" value={settings.maxRetry} onChange={(e) => num("maxRetry", e.target.value)} />
        </Row>
        <Row label="摘除阈值" hint="连续失败后标记失效">
          <Input type="number" value={settings.failThreshold} onChange={(e) => num("failThreshold", e.target.value)} />
        </Row>
        <Row label="回复超时 ms">
          <Input type="number" value={settings.replyTimeoutMs} onChange={(e) => num("replyTimeoutMs", e.target.value)} />
        </Row>
        <Row label="冷却秒数">
          <Input type="number" value={settings.coolDownSeconds} onChange={(e) => num("coolDownSeconds", e.target.value)} />
        </Row>
        <Row label="请求间隔最小 ms">
          <Input type="number" value={settings.intervalMinMs} onChange={(e) => num("intervalMinMs", e.target.value)} />
        </Row>
        <Row label="请求间隔最大 ms">
          <Input type="number" value={settings.intervalMaxMs} onChange={(e) => num("intervalMaxMs", e.target.value)} />
        </Row>
        <Row label="Worker 并发">
          <Input
            type="number"
            value={settings.concurrencyPerWorker}
            onChange={(e) => num("concurrencyPerWorker", e.target.value)}
          />
        </Row>
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-medium">ChatGPT 选择器</h2>
        <SelectorEditor
          value={settings.chatgptSelectors ?? defaultSettings.chatgptSelectors}
          onSave={(raw) => saveSelectors("chatgptSelectors", raw)}
        />
        <h2 className="pt-2 text-sm font-medium">Gemini 选择器</h2>
        <SelectorEditor
          value={settings.geminiSelectors ?? defaultSettings.geminiSelectors}
          onSave={(raw) => saveSelectors("geminiSelectors", raw)}
        />
      </div>

      <div className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-medium">数据</h2>
        <Button
          className="mt-4"
          variant="secondary"
          onClick={() => {
            resetDemo();
            toast.success("已恢复演示数据");
          }}
        >
          重置演示数据
        </Button>
      </div>
    </div>
  );
}

function SelectorEditor({ value, onSave }: { value: SelectorPack; onSave: (raw: string) => void }) {
  const [raw, setRaw] = useState(() => JSON.stringify(value, null, 2));
  return (
    <div className="space-y-2">
      <Textarea className="min-h-36 font-mono text-xs" value={raw} onChange={(e) => setRaw(e.target.value)} />
      <Button variant="secondary" size="sm" onClick={() => onSave(raw)}>
        保存选择器
      </Button>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_8rem] sm:items-center">
      <div>
        <Label>{label}</Label>
        {hint && <p className="text-[11px] text-subtle">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function ApiKeyCard() {
  const [apiKey, setApiKey] = useState("");
  const [keys, setKeys] = useState<
    { id: string; name: string; enabled: boolean; dailyLimit: number; usedToday: number; hint: string }[]
  >([]);
  const [created, setCreated] = useState("");
  const [workerToken, setWorkerToken] = useState("");
  const [name, setName] = useState("调用方");
  const [limit, setLimit] = useState("0");

  async function reload() {
    const res = await fetch("/api/keys", { credentials: "include" });
    const body = (await res.json()) as { keys?: typeof keys };
    setKeys(body.keys || []);
    const first = body.keys?.find((k) => k.enabled) || body.keys?.[0];
    if (first) setApiKey(first.hint);
    const kit = await fetch("/api/admin/worker-kit", { credentials: "include" }).then(
      (r) => r.json() as Promise<{ workerToken?: string }>,
    );
    if (kit.workerToken) setWorkerToken(`${kit.workerToken.slice(0, 10)}…`);
  }

  useEffect(() => {
    void reload();
  }, []);

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const curl = `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-5.6","messages":[{"role":"user","content":"你好"}]}'`;

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface p-5">
      <p className="text-sm font-medium">API Key</p>
      <p className="text-xs text-subtle">多把 Key 隔离调用方。额度 0 表示不限。</p>
      <ul className="space-y-2">
        {keys.map((k) => (
          <li key={k.id} className="rounded-md border border-border px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-fg">{k.name}</span>
              <span className="text-subtle">
                今日 {k.usedToday}
                {k.dailyLimit ? ` / ${k.dailyLimit}` : ""} · {k.enabled ? "启用" : "停用"}
              </span>
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted">{k.hint}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                type="button"
                onClick={() => {
                  if (!created) {
                    toast.message("完整密钥只在新建时显示一次");
                    return;
                  }
                  void navigator.clipboard.writeText(created);
                  toast.success("已复制刚创建的密钥");
                }}
              >
                复制
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => {
                  void fetch("/api/keys", {
                    method: "PATCH",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: k.id, enabled: !k.enabled }),
                  }).then(() => reload());
                }}
              >
                {k.enabled ? "停用" : "启用"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" className="sm:w-36" />
        <Input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="日限额" className="sm:w-24" />
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void fetch("/api/keys", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name, dailyLimit: Number(limit) || 0 }),
            })
              .then((r) => r.json() as Promise<{ secret?: string }>)
              .then((body) => {
                if (body.secret) {
                  setCreated(body.secret);
                  void navigator.clipboard.writeText(body.secret);
                  toast.success("新密钥只显示一次，已复制");
                }
                void reload();
              });
          }}
        >
          新建 Key
        </Button>
        <Button asChild variant="secondary">
          <Link to="/console">打开实时测试</Link>
        </Button>
      </div>
      {created && (
        <p className="break-all rounded-md bg-elevated p-2 font-mono text-[11px] text-muted">刚创建（只显示一次）：{created}</p>
      )}
      <div className="rounded-md border border-border px-3 py-2">
        <p className="text-xs font-medium">执行器凭证</p>
        <p className="mt-1 text-[11px] text-subtle">写进 Worker 的 RELAY_TOKEN，不要发给调用方。</p>
        <p className="mt-1 break-all font-mono text-[11px] text-muted">{workerToken || "…"}</p>
        <Button
          className="mt-2"
          size="sm"
          variant="secondary"
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(workerToken);
            toast.success("已复制执行器凭证");
          }}
        >
          复制执行器凭证
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-elevated p-3 font-mono text-[11px] leading-relaxed text-muted">
        {curl}
      </pre>
    </div>
  );
}
