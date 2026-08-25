import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getApiKey } from "@/lib/gateway";
import type { UsageRow } from "@/lib/usage";
import { formatFull } from "@/lib/utils";

export const Route = createFileRoute("/logs")({ component: Page });

function Page() {
  return (
    <AppShell>
      <LogsView />
    </AppShell>
  );
}

function LogsView() {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [q, setQ] = useState("");

  async function reload() {
    const key = await getApiKey();
    const res = await fetch("/api/usage", { headers: { Authorization: `Bearer ${key.apiKey}` } });
    const body = (await res.json()) as { rows?: UsageRow[] };
    setRows(body.rows || []);
  }

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 8000);
    return () => clearInterval(t);
  }, []);

  const filtered = rows.filter(
    (l) =>
      !q ||
      l.promptPreview.includes(q) ||
      l.accountEmail.includes(q) ||
      (l.error || "").includes(q) ||
      l.keyName.includes(q),
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">请求日志</h1>
          <p className="mt-1 text-sm text-muted">服务端账本：Key、账号、是否带图、耗时和失败原因。</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            void (async () => {
              const key = await getApiKey();
              const res = await fetch("/api/usage?format=csv", { headers: { Authorization: `Bearer ${key.apiKey}` } });
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "usage.csv";
              a.click();
              URL.revokeObjectURL(url);
            })();
          }}
        >
          导出 CSV
        </Button>
        <Button variant="secondary" onClick={() => void reload()}>
          刷新
        </Button>
      </header>
      <Input
        placeholder="筛选提示、账号、Key 或原因"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-sm"
      />
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-surface text-xs text-muted">
            <tr>
              <th className="px-3 py-3 font-medium">时间</th>
              <th className="px-3 py-3 font-medium">Key</th>
              <th className="px-3 py-3 font-medium">模型</th>
              <th className="px-3 py-3 font-medium">账号</th>
              <th className="px-3 py-3 font-medium">状态</th>
              <th className="px-3 py-3 font-medium">延迟</th>
              <th className="px-3 py-3 font-medium">内容</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className="px-3 py-3 text-xs text-muted">{formatFull(l.createdAt)}</td>
                <td className="px-3 py-3 text-xs">{l.keyName}</td>
                <td className="px-3 py-3 font-mono text-xs">
                  {l.model}
                  {l.images ? ` · 图${l.images}` : ""}
                </td>
                <td className="px-3 py-3 font-mono text-xs">{l.accountEmail || "—"}</td>
                <td className="px-3 py-3">
                  <Badge tone={l.ok ? "ok" : "danger"}>{l.ok ? l.mode || "成功" : "失败"}</Badge>
                </td>
                <td className="px-3 py-3 font-mono text-xs">{l.latencyMs}ms</td>
                <td className="px-3 py-3 text-xs">
                  <p>{l.promptPreview}</p>
                  {l.error && <p className="mt-1 text-danger">{l.error}</p>}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-sm text-muted">
                  还没有调用记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
