import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LogStatusBadge, PlatformBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGateway } from "@/lib/store";
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
  const logs = useGateway((s) => s.logs);
  const clearLogs = useGateway((s) => s.clearLogs);
  const [q, setQ] = useState("");
  const filtered = logs.filter(
    (l) =>
      !q ||
      l.promptPreview.includes(q) ||
      l.accountEmail.includes(q) ||
      l.detail.includes(q),
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">请求日志</h1>
          <p className="mt-1 text-sm text-muted">成功、失败与自动切换都会落盘到控制台。</p>
        </div>
        <Button variant="secondary" onClick={clearLogs}>
          清空
        </Button>
      </header>
      <Input
        placeholder="筛选提示、账号或原因"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-sm"
      />
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-surface text-xs text-muted">
            <tr>
              <th className="px-3 py-3 font-medium">时间</th>
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
                <td className="px-3 py-3 whitespace-nowrap font-mono text-[11px] text-muted">
                  {formatFull(l.createdAt)}
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <PlatformBadge platform={l.platform} />
                    <span className="font-mono text-[11px]">{l.model}</span>
                  </div>
                </td>
                <td className="px-3 py-3 font-mono text-xs">{l.accountEmail}</td>
                <td className="px-3 py-3">
                  <LogStatusBadge status={l.status} />
                </td>
                <td className="px-3 py-3 font-mono text-xs tabular-nums">{l.latencyMs}ms</td>
                <td className="px-3 py-3">
                  <p className="max-w-sm truncate">{l.promptPreview}</p>
                  <p className="text-[11px] text-subtle">{l.detail}</p>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-muted">
                  暂无日志
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
