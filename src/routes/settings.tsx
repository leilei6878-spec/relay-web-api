import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { getApiKey } from "@/lib/gateway";
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
        <h1 className="text-2xl font-medium tracking-tight">调度设置</h1>
        <p className="mt-2 text-sm text-muted">
          sticky 强制、失败换号、回复超时。页面改版只改选择器，不改调度代码。
        </p>
      </header>

      <ApiKeyCard />

      <div className="space-y-4 rounded-xl border border-border bg-surface p-5">
        <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
          <span>
            强制 sticky 代理
            <span className="mt-0.5 block text-[11px] text-subtle">
              无代理的号不能进入健康池、不能被调度
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.enforceProxy}
            onChange={(e) => updateSettings({ enforceProxy: e.target.checked })}
          />
        </label>
        <Row label="单请求最大换号" hint="失败后换号次数">
          <Input
            type="number"
            value={settings.maxRetry}
            onChange={(e) => num("maxRetry", e.target.value)}
          />
        </Row>
        <Row label="摘除阈值" hint="连续失败后标记失效">
          <Input
            type="number"
            value={settings.failThreshold}
            onChange={(e) => num("failThreshold", e.target.value)}
          />
        </Row>
        <Row label="回复超时 ms" hint="等流结束，超时才失败">
          <Input
            type="number"
            value={settings.replyTimeoutMs}
            onChange={(e) => num("replyTimeoutMs", e.target.value)}
          />
        </Row>
        <Row label="冷却秒数">
          <Input
            type="number"
            value={settings.coolDownSeconds}
            onChange={(e) => num("coolDownSeconds", e.target.value)}
          />
        </Row>
        <Row label="请求间隔最小 ms">
          <Input
            type="number"
            value={settings.intervalMinMs}
            onChange={(e) => num("intervalMinMs", e.target.value)}
          />
        </Row>
        <Row label="请求间隔最大 ms">
          <Input
            type="number"
            value={settings.intervalMaxMs}
            onChange={(e) => num("intervalMaxMs", e.target.value)}
          />
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
        <p className="mt-1 text-sm text-muted">账号、代理与日志保存在本机浏览器。</p>
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
      <Textarea
        className="min-h-36 font-mono text-xs"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <Button variant="secondary" size="sm" onClick={() => onSave(raw)}>
        保存选择器
      </Button>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
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
  useEffect(() => {
    void getApiKey().then((r) => setApiKey(r.apiKey));
  }, []);
  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface p-5">
      <p className="text-sm font-medium">对外 API Key</p>
      <p className="text-xs text-subtle">调用 POST /v1/chat/completions 时放在 Authorization: Bearer</p>
      <Input readOnly value={apiKey} className="font-mono text-xs" />
      <p className="text-[11px] text-subtle">本机 Worker 启动时用同一把钥匙拉任务。</p>
    </div>
  );
}
