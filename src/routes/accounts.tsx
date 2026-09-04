import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { AccountStatusBadge, PlatformBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { diagnoseSessionFile, saveSessionFile } from "@/lib/gateway";
import { createPendingAccount, persistControlPlane } from "@/lib/control-plane-client";
import { whyBlocked } from "@/lib/readiness";
import { useGateway } from "@/lib/store";
import { safeName } from "@/lib/session-file";
import type { Account, AccountStatus, Platform } from "@/lib/types";
import type { AccountOperationalRow } from "@/lib/account-operations";
import { formatFull, formatTime } from "@/lib/utils";

type OperationsResponse = {
  rows: AccountOperationalRow[];
  total: number;
  page: number;
  pageSize: number;
  stats: {
    total: number;
    available: number;
    schedulable: number;
    busy: number;
    expiring24h: number;
    expiring7d: number;
    invalid: number;
    ipDrift: number;
    pendingCheck: number;
  };
  facets: { batches: string[]; tags: string[] };
  error?: string;
};

export const Route = createFileRoute("/accounts")({ component: Page });

function Page() {
  return (
    <AppShell>
      <AccountsView />
    </AppShell>
  );
}

function AccountsView() {
  const accounts = useGateway((s) => s.accounts);
  const proxies = useGateway((s) => s.proxies);
  const settings = useGateway((s) => s.settings);
  const [platform, setPlatform] = useState<"all" | Platform>("all");
  const [status, setStatus] = useState<"all" | AccountStatus>("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<"all" | "expired" | "24h" | "7d" | "none">("all");
  const [ipState, setIpState] = useState<"all" | "matched" | "drift" | "unknown" | "proxy_unavailable">("all");
  const [batch, setBatch] = useState("all");
  const [proxyId, setProxyId] = useState("all");
  const [operations, setOperations] = useState<OperationsResponse | null>(null);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const fallbackFiltered = useMemo(
    () =>
      accounts.filter((a) => {
        if (platform !== "all" && a.platform !== platform) return false;
        if (status !== "all" && a.status !== status) return false;
        if (q && !a.email.includes(q) && !a.remark.includes(q)) return false;
        return true;
      }),
    [accounts, platform, status, q],
  );

  const loadOperations = useCallback(async () => {
    const search = new URLSearchParams({
      q,
      platform,
      status,
      expiry,
      ipState,
      pageSize: "200",
    });
    if (batch !== "all") search.set("batch", batch);
    if (proxyId !== "all") search.set("proxyId", proxyId);
    setOperationsLoading(true);
    try {
      const response = await fetch(`/api/admin/account-operations?${search}`, { credentials: "include" });
      const body = (await response.json()) as OperationsResponse;
      if (!response.ok) throw new Error(body.error || "账号运营数据读取失败");
      setOperations(body);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "账号运营数据读取失败");
    } finally {
      setOperationsLoading(false);
    }
  }, [batch, expiry, ipState, platform, proxyId, q, status]);

  useEffect(() => {
    const delay = setTimeout(() => void loadOperations(), 180);
    const timer = setInterval(() => void loadOperations(), 15_000);
    return () => {
      clearTimeout(delay);
      clearInterval(timer);
    };
  }, [loadOperations, accounts.length]);

  const filtered: AccountOperationalRow[] =
    operations?.rows ??
    fallbackFiltered.map((account) => ({
      ...account,
      available: !whyBlocked(account, proxies, settings),
      schedulable: !whyBlocked(account, proxies, settings),
      availabilityReason: whyBlocked(account, proxies, settings),
      schedulingReason: whyBlocked(account, proxies, settings),
      busy: Boolean(account.lockedUntil && Date.parse(account.lockedUntil) > Date.now()),
      proxyName: proxies.find((proxy) => proxy.id === account.proxyId)?.name || "",
      proxyRegion: proxies.find((proxy) => proxy.id === account.proxyId)?.region || "",
      expectedIp: proxies.find((proxy) => proxy.id === account.proxyId)?.lastCheckIp || account.loginIp || null,
    }));
  const detailAccount = detailId ? filtered.find((account) => account.id === detailId) || accounts.find((account) => account.id === detailId) || null : null;

  const deleteAccount = useGateway((s) => s.deleteAccount);
  const updateAccount = useGateway((s) => s.updateAccount);

  async function patchOperations(id: string, patch: Record<string, unknown>) {
    const response = await fetch("/api/admin/account-operations", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, patch }),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; account?: Account };
    if (!response.ok || !body.ok || !body.account) throw new Error(body.error || "账号资料保存失败");
    updateAccount(id, body.account);
    await loadOperations();
    return body.account;
  }

  async function bulkPatchOperations(ids: string[], patch: Record<string, unknown>) {
    const response = await fetch("/api/admin/account-operations", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, patch }),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; updated?: number };
    if (!response.ok || !body.ok) throw new Error(body.error || "批量保存失败");
    await loadOperations();
    return body.updated || 0;
  }

  async function releaseInspection(account: AccountOperationalRow) {
    const response = await fetch("/api/admin/account-inspections", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "force-close", accountId: account.id }),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; released?: number; error?: string };
    if (!response.ok || !body.ok) throw new Error(body.error || "释放账号占用失败");
    updateAccount(account.id, { lockedUntil: null, inspectionId: null });
    await loadOperations();
    toast.success(body.released ? "查看会话已关闭，账号占用已释放" : "账号占用状态已校正");
  }

  function bulkDelete() {
    selected.forEach(deleteAccount);
    setSelected([]);
    toast.success("已删除选中账号");
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">账号池</h1>
          <p className="mt-1 text-sm text-muted">添加 → 绑代理 → 登录。可调用的号才会被 API 选中。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ManualCheckDialog
            selectedIds={selected}
            currentScope={{
              q,
              platform,
              status,
              batch: batch === "all" ? "" : batch,
              expiry,
              ipState,
              proxyId: proxyId === "all" ? "" : proxyId,
            }}
            onComplete={() => void loadOperations()}
          />
          <ImportDialog />
          <AddDialog />
        </div>
      </header>

      <AccountStats stats={operations?.stats} loading={operationsLoading} />
      <AvailabilityTrend />

      {accounts.length === 0 && (
        <p className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">
          当前页面是空的。账号通常还在服务器上，只是管理登录没带上。请刷新本页；不要重新导入。
        </p>
      )}
      {accounts.some((a) => a.platform === "leonardo" && a.status === "pending_login") && (
        <div className="rounded-xl border border-border bg-surface px-4 py-3 text-sm">
          <p className="font-medium text-fg">Leonardo 登录还没完成</p>
          <p className="mt-1 text-muted">
            当前文件只有游客 Cookie，没有 Leonardo Session。必须用 Canva 授权：先在专用窗口登录
            canva.com 国际站，再在 Leonardo 点 Continue with Canva，授权弹窗走完、Sign In 消失后把新的
            state.json 拖回来。公开出图页不算登录。
          </p>
        </div>
      )}

      <ol className="grid gap-3 rounded-xl border border-border bg-surface p-4 text-sm text-muted sm:grid-cols-3">
        <li>
          <p className="font-medium text-fg">1. 添加并绑代理</p>
          <p className="mt-1 text-xs leading-relaxed text-subtle">
            先入库邮箱，再选一条 sticky IP。登录和之后调用必须走同一出口。
          </p>
        </li>
        <li>
          <p className="font-medium text-fg">2. 在你电脑登录</p>
          <p className="mt-1 text-xs leading-relaxed text-subtle">
            点「登录」下载登录包，双击 run.bat。日常 Chrome 不用关。只会弹出一个专用窗口（带上你已登录的 Canva），只在那个窗口里给 Leonardo 授权。
          </p>
        </li>
        <li>
          <p className="font-medium text-fg">3. 把登录文件拖回来</p>
          <p className="mt-1 text-xs leading-relaxed text-subtle">
            窗口登录成功后会生成文件。拖到账号这一行的登录框，状态变成可调用。Leonardo 必须出现 Session Cookie，停在 Image Generator。
          </p>
        </li>
      </ol>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          placeholder="搜索邮箱、备注、标签、批次、代理或 IP"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="sm:max-w-xs"
        />
        <Select value={platform} onValueChange={(v) => setPlatform(v as typeof platform)}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部平台</SelectItem>
            <SelectItem value="chatgpt">ChatGPT</SelectItem>
            <SelectItem value="gemini">Gemini</SelectItem>
            <SelectItem value="leonardo">Leonardo</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="healthy">健康</SelectItem>
            <SelectItem value="pending_login">待登录</SelectItem>
            <SelectItem value="cooling">冷却</SelectItem>
            <SelectItem value="invalid">失效</SelectItem>
            <SelectItem value="banned">封禁</SelectItem>
          </SelectContent>
        </Select>
        <Select value={expiry} onValueChange={(v) => setExpiry(v as typeof expiry)}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部期限</SelectItem>
            <SelectItem value="expired">已经过期</SelectItem>
            <SelectItem value="24h">24 小时内</SelectItem>
            <SelectItem value="7d">7 天内</SelectItem>
            <SelectItem value="none">未设置期限</SelectItem>
          </SelectContent>
        </Select>
        <Select value={ipState} onValueChange={(v) => setIpState(v as typeof ipState)}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部 IP 状态</SelectItem>
            <SelectItem value="matched">IP 一致</SelectItem>
            <SelectItem value="drift">IP 漂移</SelectItem>
            <SelectItem value="proxy_unavailable">代理不可用</SelectItem>
            <SelectItem value="unknown">IP 未知</SelectItem>
          </SelectContent>
        </Select>
        <Select value={batch} onValueChange={setBatch}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部批次</SelectItem>
            {(operations?.facets.batches || []).map((item) => (
              <SelectItem key={item} value={item}>{item}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={proxyId} onValueChange={setProxyId}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部代理</SelectItem>
            {proxies.map((proxy) => (
              <SelectItem key={proxy.id} value={proxy.id}>{proxy.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected.length > 0 && (
          <>
            <BulkMetadataDialog
              count={selected.length}
              onSave={async (patch) => {
                const updated = await bulkPatchOperations(selected, patch);
                toast.success(`已更新 ${updated} 个账号`);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                selected.forEach((id) => updateAccount(id, { status: "invalid" }));
                toast.success("已批量下线");
              }}
            >
              下线 {selected.length} 个
            </Button>
            <Button variant="destructive" size="sm" onClick={bulkDelete}>
              删除 {selected.length} 个
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={() => void loadOperations()} disabled={operationsLoading}>
          {operationsLoading ? "刷新中…" : "刷新"}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[1360px] text-left text-sm">
          <thead className="bg-surface text-xs text-muted">
            <tr>
              <th className="px-3 py-3">
                <input
                  type="checkbox"
                  aria-label="全选"
                  checked={filtered.length > 0 && selected.length === filtered.length}
                  onChange={(e) =>
                    setSelected(e.target.checked ? filtered.map((a) => a.id) : [])
                  }
                />
              </th>
              <th className="px-3 py-3 font-medium">账号</th>
              <th className="px-3 py-3 font-medium">平台 / 状态</th>
              <th className="px-3 py-3 font-medium">可用性</th>
              <th className="px-3 py-3 font-medium">添加 / 到期</th>
              <th className="px-3 py-3 font-medium">登录 IP</th>
              <th className="px-3 py-3 font-medium">代理</th>
              <th className="px-3 py-3 font-medium">Session / 检查</th>
              <th className="px-3 py-3 font-medium">请求 / 失败</th>
              <th className="px-3 py-3 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.id} className="border-t border-border">
                <td className="px-3 py-3">
                  <input
                    type="checkbox"
                    checked={selected.includes(a.id)}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked ? [...s, a.id] : s.filter((id) => id !== a.id),
                      )
                    }
                    aria-label={a.email}
                  />
                </td>
                <td className="px-3 py-3">
                  <button type="button" className="text-left" onClick={() => setDetailId(a.id)}>
                    <p className="font-mono text-xs text-fg hover:underline">{a.email}</p>
                  </button>
                  <p className="max-w-72 truncate text-[11px] text-subtle">{a.remark || "无备注"}</p>
                  <div className="mt-1 flex max-w-72 flex-wrap gap-1">
                    {a.batch ? <Badge>{a.batch}</Badge> : null}
                    {(a.tags || []).slice(0, 4).map((tag) => <Badge key={tag}>{tag}</Badge>)}
                  </div>
                  {a.sessionWarning && <p className="text-[11px] text-warn">{a.sessionWarning}</p>}
                  {a.lastError && <p className="text-[11px] text-danger">{a.lastError}</p>}
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-col items-start gap-1.5">
                    <PlatformBadge platform={a.platform} />
                    <AccountStatusBadge status={a.status} />
                    {a.tokenState ? <span className="text-[11px] text-subtle">{a.tokenState}</span> : null}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-col items-start gap-1">
                    <Badge tone={a.available ? "ok" : "danger"}>{a.available ? "健康可用" : "不可用"}</Badge>
                    <Badge tone={a.schedulable ? "ok" : a.busy ? "warn" : "default"}>
                      {a.schedulable ? "当前可调度" : a.busy ? "占用中" : "不可调度"}
                    </Badge>
                    {a.schedulingReason ? <span className="max-w-40 text-[11px] text-subtle">{a.schedulingReason}</span> : null}
                    <span className="text-[11px] text-subtle">健康分 {a.healthScore ?? "—"}</span>
                  </div>
                </td>
                <td className="px-3 py-3 text-xs text-muted">
                  <p>添加 {formatTime(a.createdAt)}</p>
                  <p className={a.expiresAt && Date.parse(a.expiresAt) <= Date.now() ? "text-danger" : ""}>
                    到期 {formatTime(a.expiresAt)}
                  </p>
                  <p>登录态 {formatTime(a.sessionExpiresAt)}</p>
                </td>
                <td className="px-3 py-3 font-mono text-[11px]">
                  <IpStateBadge state={a.ipState || "unknown"} />
                  <p className="mt-1 text-subtle">登录 {a.loginIp || "—"}</p>
                  <p className="text-subtle">检查 {a.lastProbeIp || "—"}</p>
                  <p className="text-subtle">预期 {a.expectedIp || "—"}</p>
                </td>
                <td className="px-3 py-3">
                  <select
                    className="h-9 max-w-36 rounded-sm border border-border bg-elevated px-2 text-xs"
                    value={a.proxyId ?? ""}
                    onChange={(e) => {
                      void patchOperations(a.id, { proxyId: e.target.value || null }).catch((error) =>
                        toast.error(error instanceof Error ? error.message : "代理绑定失败"),
                      );
                    }}
                  >
                    <option value="">未绑定</option>
                    {proxies.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-subtle">{a.proxyRegion || "未配置地区"}</p>
                </td>
                <td className="px-3 py-3 text-[11px] text-muted">
                  <p>{a.sessionCookieCount || 0} Cookie · v{a.sessionVersion || 0}</p>
                  <p>页面 {a.lastPageState || "未知"}</p>
                  <p>上次 {formatTime(a.lastProbeAt)}</p>
                  <p>下次 {a.autoCheck === false ? "已关闭" : formatTime(a.nextProbeAt)}</p>
                </td>
                <td className="px-3 py-3 font-mono text-xs tabular-nums">
                  <p>{a.totalRequests} / {a.failCount}</p>
                  <p className="mt-1 text-[11px] text-subtle">使用 {formatTime(a.lastUsedAt)}</p>
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setDetailId(a.id)}>详情</Button>
                    <LoginDialog account={a} />
                    {a.status !== "healthy" && a.status !== "pending_login" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const r = useGateway.getState().promoteHealthy(a.id);
                          if (!r.ok) toast.error(r.error);
                        }}
                      >
                        上线
                      </Button>
                    )}
                    <ManualCheckDialog
                      compact
                      selectedIds={[a.id]}
                      currentScope={{}}
                      onComplete={() => void loadOperations()}
                    />
                    {a.busy && a.inspectionId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void releaseInspection(a).catch((error) => toast.error(error.message))}
                      >
                        释放查看占用
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => updateAccount(a.id, { status: "invalid" })}
                    >
                      下线
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => deleteAccount(a.id)}>
                      删除
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-10 text-center text-sm text-muted">
                  没有匹配的账号
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AccountDetailSheet
        account={detailAccount}
        open={Boolean(detailAccount)}
        onOpenChange={(open) => !open && setDetailId(null)}
        onSave={async (patch) => {
          if (!detailAccount) return;
          await patchOperations(detailAccount.id, patch);
          toast.success("账号资料已保存");
        }}
      />
    </div>
  );
}

function ManualCheckDialog({
  selectedIds,
  currentScope,
  onComplete,
  compact = false,
}: {
  selectedIds: string[];
  currentScope: Record<string, unknown>;
  onComplete: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [scopeMode, setScopeMode] = useState<"selected" | "current" | "all">(selectedIds.length ? "selected" : "current");
  const [levels, setLevels] = useState({ static: true, proxy: true, live: true });
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<{
    status: string;
    total: number;
    completed: number;
    passed: number;
    failed: number;
    cancelled: number;
  } | null>(null);
  const [checks, setChecks] = useState<{ id: string; level: string; status: string; resultCode: string | null; detail: string | null }[]>([]);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open || !runId) return;
    let stopped = false;
    async function poll() {
      const response = await fetch(`/api/admin/account-checks?runId=${encodeURIComponent(runId)}`, { credentials: "include" });
      if (!response.ok || stopped) return;
      const body = (await response.json()) as { run: typeof run; checks?: typeof checks };
      if (!body.run) return;
      setRun(body.run);
      setChecks(body.checks || []);
      if (body.run.status === "done" || body.run.status === "cancelled") onComplete();
    }
    void poll();
    const timer = setInterval(() => void poll(), 1200);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [open, runId, onComplete]);

  async function start() {
    const picked = (Object.entries(levels) as [keyof typeof levels, boolean][]).filter(([, enabled]) => enabled).map(([level]) => level);
    if (!picked.length) {
      toast.error("至少选择一种检查方式");
      return;
    }
    const scope = compact || scopeMode === "selected"
      ? { ids: selectedIds }
      : scopeMode === "current"
        ? Object.fromEntries(Object.entries(currentScope).filter(([, value]) => value && value !== "all"))
        : {};
    setStarting(true);
    try {
      const response = await fetch("/api/admin/account-checks", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", scope, levels: picked }),
      });
      const body = (await response.json()) as { ok?: boolean; runId?: string; total?: number; error?: string };
      if (!response.ok || !body.ok || !body.runId) throw new Error(body.error || "检查任务创建失败");
      setRunId(body.runId);
      setRun({ status: "queued", total: body.total || 0, completed: 0, passed: 0, failed: 0, cancelled: 0 });
      toast.success(`已创建 ${body.total || 0} 个账号的检查任务`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "检查任务创建失败");
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!runId) return;
    await fetch("/api/admin/account-checks", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel", runId }),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(value) => {
      setOpen(value);
      if (value && !runId) setScopeMode(selectedIds.length ? "selected" : "current");
    }}>
      <DialogTrigger asChild>
        <Button variant={compact ? "ghost" : "secondary"} size={compact ? "sm" : "default"}>{compact ? "检查" : "立即检查账号"}</Button>
      </DialogTrigger>
      <DialogContent title="账号可用性检查" className="max-w-xl">
        {!runId ? (
          <div className="space-y-4">
            {!compact ? (
              <Field label="检查范围">
                <Select value={scopeMode} onValueChange={(value) => setScopeMode(value as typeof scopeMode)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {selectedIds.length ? <SelectItem value="selected">选中的 {selectedIds.length} 个账号</SelectItem> : null}
                    <SelectItem value="current">当前检索结果</SelectItem>
                    <SelectItem value="all">全部账号</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ) : <p className="text-sm text-muted">检查当前账号</p>}
            <div>
              <p className="text-xs font-medium text-muted">检查层级</p>
              <div className="mt-2 space-y-2 text-sm text-muted">
                <label className="flex items-start gap-2"><input type="checkbox" checked={levels.static} onChange={(event) => setLevels((value) => ({ ...value, static: event.target.checked }))} /><span><b className="text-fg">Session 静态检查</b><br /><span className="text-xs text-subtle">Cookie、文件完整性和预计过期时间</span></span></label>
                <label className="flex items-start gap-2"><input type="checkbox" checked={levels.proxy} onChange={(event) => setLevels((value) => ({ ...value, proxy: event.target.checked }))} /><span><b className="text-fg">代理与出口 IP</b><br /><span className="text-xs text-subtle">检查真实出口并识别 IP 漂移</span></span></label>
                <label className="flex items-start gap-2"><input type="checkbox" checked={levels.live} onChange={(event) => setLevels((value) => ({ ...value, live: event.target.checked }))} /><span><b className="text-fg">真实网页检查</b><br /><span className="text-xs text-subtle">打开平台并验证登录页面，不发送聊天、不生成图片</span></span></label>
              </div>
            </div>
            <Button className="w-full" onClick={() => void start()} disabled={starting}>{starting ? "创建中…" : "开始检查"}</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-elevated p-4">
              <div className="flex items-center justify-between"><p className="text-sm font-medium">{run?.status === "done" ? "检查完成" : run?.status === "cancelled" ? "检查已停止" : "检查进行中"}</p><span className="text-xs text-muted">{run?.completed || 0}/{run?.total || 0}</span></div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface"><div className="h-full bg-primary transition-all" style={{ width: `${run?.total ? Math.round((run.completed / run.total) * 100) : 0}%` }} /></div>
              <div className="mt-3 flex gap-4 text-xs"><span className="text-ok">通过 {run?.passed || 0}</span><span className="text-danger">失败 {run?.failed || 0}</span><span className="text-muted">取消 {run?.cancelled || 0}</span></div>
            </div>
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {checks.slice(-30).reverse().map((check) => (
                <div key={check.id} className="rounded-md border border-border px-3 py-2 text-xs">
                  <div className="flex justify-between gap-2"><span>{check.level}</span><Badge tone={check.status === "passed" ? "ok" : "danger"}>{check.resultCode || check.status}</Badge></div>
                  {check.detail ? <p className="mt-1 text-subtle">{check.detail}</p> : null}
                </div>
              ))}
            </div>
            {run?.status === "queued" || run?.status === "running" ? <Button variant="destructive" className="w-full" onClick={() => void cancel()}>停止未开始的检查</Button> : <Button variant="secondary" className="w-full" onClick={() => { setRunId(""); setRun(null); setChecks([]); }}>新建检查</Button>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AccountStats({ stats, loading }: { stats?: OperationsResponse["stats"]; loading: boolean }) {
  const cards = [
    ["账号总数", stats?.total ?? 0, "text-fg"],
    ["健康可用", stats?.available ?? 0, "text-ok"],
    ["当前可调度", stats?.schedulable ?? 0, "text-ok"],
    ["正在占用", stats?.busy ?? 0, "text-warn"],
    ["24h 内到期", stats?.expiring24h ?? 0, "text-warn"],
    ["7 天内到期", stats?.expiring7d ?? 0, "text-muted"],
    ["失效/封禁", stats?.invalid ?? 0, "text-danger"],
    ["IP 异常", stats?.ipDrift ?? 0, "text-danger"],
    ["待检查", stats?.pendingCheck ?? 0, "text-info"],
  ] as const;
  return (
    <div className={`grid gap-2 sm:grid-cols-3 lg:grid-cols-5 ${loading ? "opacity-70" : ""}`}>
      {cards.map(([label, value, tone]) => (
        <div key={label} className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] text-subtle">{label}</p>
          <p className={`mt-1 text-2xl font-medium tabular-nums ${tone}`}>{value}</p>
        </div>
      ))}
    </div>
  );
}

function AvailabilityTrend() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [platform, setPlatform] = useState<"all" | Platform>("all");
  const [series, setSeries] = useState<{
    day: string;
    platform: "all" | Platform;
    total: number;
    available: number;
    schedulable: number;
    minimum: number;
    maximum: number;
    average: number;
    added: number;
    expired: number;
    recovered: number;
    invalid: number;
    ipDrift: number;
  }[]>([]);

  useEffect(() => {
    let stopped = false;
    void fetch(`/api/admin/account-analytics?days=${days}`, { credentials: "include" })
      .then((response) => response.json())
      .then((body: { series?: typeof series }) => {
        if (!stopped) setSeries(body.series || []);
      })
      .catch(() => undefined);
    return () => { stopped = true; };
  }, [days]);

  const rows = series.filter((row) => row.platform === platform).slice().reverse();
  return (
    <section className="rounded-xl border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div><h2 className="text-sm font-medium">每日可用账号</h2><p className="mt-0.5 text-[11px] text-subtle">按小时采样，保留当日当前值、最高值和最低值</p></div>
        <div className="flex flex-wrap gap-2">
          <Select value={platform} onValueChange={(value) => setPlatform(value as typeof platform)}><SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="all">全部平台</SelectItem><SelectItem value="chatgpt">ChatGPT</SelectItem><SelectItem value="gemini">Gemini</SelectItem><SelectItem value="leonardo">Leonardo</SelectItem>
          </SelectContent></Select>
          {[7, 30, 90].map((value) => <Button key={value} variant={days === value ? "default" : "ghost"} size="sm" onClick={() => setDays(value as typeof days)}>{value} 天</Button>)}
        </div>
      </header>
      <div className="max-h-72 overflow-auto">
        <table className="w-full min-w-[780px] text-left text-xs">
          <thead className="sticky top-0 bg-surface text-subtle"><tr><th className="px-4 py-2">日期</th><th>可用 / 总数</th><th>当前可调度</th><th>最低 / 最高</th><th>平均</th><th>新增</th><th>到期</th><th>恢复</th><th>失效</th><th>IP 异常</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={`${row.day}:${row.platform}`} className="border-t border-border"><td className="px-4 py-2.5 font-mono">{row.day}</td><td className="text-ok">{row.available} / {row.total}</td><td>{row.schedulable}</td><td>{row.minimum} / {row.maximum}</td><td>{row.average}</td><td>{row.added}</td><td>{row.expired}</td><td>{row.recovered}</td><td className={row.invalid ? "text-danger" : ""}>{row.invalid}</td><td className={row.ipDrift ? "text-danger" : ""}>{row.ipDrift}</td></tr>)}</tbody>
        </table>
        {!rows.length ? <p className="px-4 py-8 text-center text-xs text-subtle">首次部署后会立即生成今天的可用量样本</p> : null}
      </div>
    </section>
  );
}

function IpStateBadge({ state }: { state: NonNullable<Account["ipState"]> }) {
  if (state === "matched") return <Badge tone="ok">IP 一致</Badge>;
  if (state === "drift") return <Badge tone="danger">IP 漂移</Badge>;
  if (state === "proxy_unavailable") return <Badge tone="danger">代理不可用</Badge>;
  return <Badge>IP 未知</Badge>;
}

function inputDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function BulkMetadataDialog({ count, onSave }: { count: number; onSave: (patch: Record<string, unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [batch, setBatch] = useState("");
  const [tags, setTags] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [status, setStatus] = useState("keep");
  const [autoCheck, setAutoCheck] = useState("keep");
  const [saving, setSaving] = useState(false);

  async function save() {
    const patch: Record<string, unknown> = {};
    if (batch.trim()) patch.batch = batch.trim();
    if (tags.trim()) patch.tags = tags.split(",").map((item) => item.trim()).filter(Boolean);
    if (expiresAt) patch.expiresAt = new Date(expiresAt).toISOString();
    if (status !== "keep") patch.status = status;
    if (autoCheck !== "keep") patch.autoCheck = autoCheck === "on";
    if (!Object.keys(patch).length) {
      toast.error("至少填写一项批量修改内容");
      return;
    }
    setSaving(true);
    try {
      await onSave(patch);
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "批量保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="secondary" size="sm">批量编辑 {count} 个</Button></DialogTrigger>
      <DialogContent title={`批量编辑 ${count} 个账号`}>
        <div className="space-y-3">
          <Field label="批次（留空表示不修改）"><Input value={batch} onChange={(event) => setBatch(event.target.value)} /></Field>
          <Field label="标签，使用英文逗号分隔"><Input value={tags} onChange={(event) => setTags(event.target.value)} /></Field>
          <Field label="业务到期时间"><Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></Field>
          <Field label="账号状态">
            <Select value={status} onValueChange={setStatus}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="keep">不修改</SelectItem><SelectItem value="healthy">上线</SelectItem><SelectItem value="invalid">下线</SelectItem>
            </SelectContent></Select>
          </Field>
          <Field label="定时检查">
            <Select value={autoCheck} onValueChange={setAutoCheck}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="keep">不修改</SelectItem><SelectItem value="on">开启</SelectItem><SelectItem value="off">关闭</SelectItem>
            </SelectContent></Select>
          </Field>
          <Button className="w-full" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "应用批量修改"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AccountDetailSheet({
  account,
  open,
  onOpenChange,
  onSave,
}: {
  account: Account | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [remark, setRemark] = useState("");
  const [batch, setBatch] = useState("");
  const [tags, setTags] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [loginIp, setLoginIp] = useState("");
  const [autoCheck, setAutoCheck] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRemark(account?.remark || "");
    setBatch(account?.batch || "");
    setTags((account?.tags || []).join(", "));
    setExpiresAt(inputDate(account?.expiresAt));
    setLoginIp(account?.loginIp || "");
    setAutoCheck(account?.autoCheck !== false);
  }, [account?.id, account?.updatedAt]);

  async function save() {
    if (!account) return;
    setSaving(true);
    try {
      await onSave({
        remark,
        batch,
        tags: tags.split(",").map((item) => item.trim()).filter(Boolean),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        loginIp: loginIp || null,
        autoCheck,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "账号资料保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="left-auto right-0 w-[min(44rem,96vw)] overflow-y-auto border-l border-r-0 p-0">
        {account ? (
          <div className="space-y-6 p-5">
            <header className="border-b border-border pb-4">
              <div className="flex flex-wrap items-center gap-2"><PlatformBadge platform={account.platform} /><AccountStatusBadge status={account.status} /></div>
              <h2 className="mt-3 break-all font-mono text-base text-fg">{account.email}</h2>
              <p className="mt-1 text-xs text-muted">账号 ID {account.id}</p>
              <div className="mt-4"><InspectionDialog account={account} /></div>
            </header>

            <section>
              <h3 className="text-sm font-medium">账号资料</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="批次"><Input value={batch} onChange={(event) => setBatch(event.target.value)} /></Field>
                <Field label="业务到期时间"><Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></Field>
                <Field label="标签（英文逗号分隔）"><Input value={tags} onChange={(event) => setTags(event.target.value)} /></Field>
                <Field label="最后登录 IP"><Input value={loginIp} onChange={(event) => setLoginIp(event.target.value)} placeholder="自动探测或人工登记" /></Field>
              </div>
              <div className="mt-3"><Field label="备注"><Textarea rows={4} value={remark} onChange={(event) => setRemark(event.target.value)} /></Field></div>
              <label className="mt-3 flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={autoCheck} onChange={(event) => setAutoCheck(event.target.checked)} />参加定时可用性检查</label>
              <Button className="mt-4" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存账号资料"}</Button>
            </section>

            <section className="rounded-xl border border-border bg-elevated p-4">
              <h3 className="text-sm font-medium">生命周期</h3>
              <dl className="mt-3 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
                <Detail label="添加时间" value={formatFull(account.createdAt)} />
                <Detail label="更新时间" value={formatFull(account.updatedAt)} />
                <Detail label="最近使用" value={formatFull(account.lastUsedAt)} />
                <Detail label="业务到期" value={formatFull(account.expiresAt)} />
                <Detail label="登录态到期" value={formatFull(account.sessionExpiresAt)} />
                <Detail label="Session 保存" value={formatFull(account.sessionSavedAt)} />
              </dl>
            </section>

            <section className="rounded-xl border border-border bg-elevated p-4">
              <h3 className="text-sm font-medium">登录态与代理</h3>
              <dl className="mt-3 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
                <Detail label="登录 IP" value={account.loginIp || "—"} />
                <Detail label="最近检查 IP" value={account.lastProbeIp || "—"} />
                <Detail label="IP 状态" value={account.ipState || "unknown"} />
                <Detail label="Cookie" value={`${account.sessionCookieCount || 0} 枚`} />
                <Detail label="Session 版本" value={String(account.sessionVersion || 0)} />
                <Detail label="页面状态" value={account.lastPageState || "未知"} />
                <Detail label="Token" value={account.tokenState || "UNKNOWN"} />
                <Detail label="下次检查" value={account.autoCheck === false ? "已关闭" : formatFull(account.nextProbeAt)} />
              </dl>
              {account.availableModels?.length ? <p className="mt-3 text-xs text-muted">模型：{account.availableModels.join(" · ")}</p> : null}
            </section>

            <section className="rounded-xl border border-border bg-elevated p-4">
              <h3 className="text-sm font-medium">检查结果</h3>
              <dl className="mt-3 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
                <Detail label="最近检查" value={formatFull(account.lastProbeAt)} />
                <Detail label="最近网页检查" value={formatFull(account.lastLiveProbeAt)} />
                <Detail label="连续失败" value={String(account.consecutiveProbeFailures || 0)} />
                <Detail label="健康分" value={String(account.healthScore ?? "—")} />
              </dl>
              {account.lastError ? <p className="mt-3 text-xs text-danger">{account.lastError}</p> : null}
            </section>
            <AccountCheckHistory accountId={account.id} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function AccountCheckHistory({ accountId }: { accountId: string }) {
  const [checks, setChecks] = useState<{
    id: string;
    level: string;
    status: string;
    resultCode: string | null;
    detail: string | null;
    observedIp: string | null;
    startedAt: string;
    latencyMs: number | null;
  }[]>([]);
  useEffect(() => {
    let stopped = false;
    void fetch(`/api/admin/account-checks?accountId=${encodeURIComponent(accountId)}&limit=30`, { credentials: "include" })
      .then((response) => response.json())
      .then((body: { checks?: typeof checks }) => { if (!stopped) setChecks(body.checks || []); })
      .catch(() => undefined);
    return () => { stopped = true; };
  }, [accountId]);
  return (
    <section className="rounded-xl border border-border bg-elevated p-4">
      <h3 className="text-sm font-medium">最近检查记录</h3>
      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
        {checks.map((check) => (
          <div key={check.id} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2"><span>{formatFull(check.startedAt)} · {check.level} · {check.latencyMs ?? 0}ms</span><Badge tone={check.status === "passed" ? "ok" : "danger"}>{check.resultCode || check.status}</Badge></div>
            {check.observedIp ? <p className="mt-1 font-mono text-subtle">出口 {check.observedIp}</p> : null}
            {check.detail ? <p className="mt-1 text-subtle">{check.detail}</p> : null}
          </div>
        ))}
        {!checks.length ? <p className="text-xs text-subtle">暂无检查记录</p> : null}
      </div>
    </section>
  );
}

function InspectionDialog({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"view" | "maintenance">("view");
  const [starting, setStarting] = useState(false);
  const [inspection, setInspection] = useState<{
    id: string;
    token: string;
    status: string;
    frameSeq: number;
    pageUrl: string;
    pageTitle: string;
    observedIp: string | null;
    viewportWidth: number;
    viewportHeight: number;
  } | null>(null);
  const [frameUrl, setFrameUrl] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const command = useCallback(async (value: Record<string, unknown>) => {
    if (!inspection) return;
    const response = await fetch("/api/admin/account-inspections", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "command", id: inspection.id, token: inspection.token, command: value }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(body.error || "远程操作失败");
  }, [inspection]);

  useEffect(() => {
    if (!open || !inspection) return;
    let stopped = false;
    let objectUrl = "";
    let lastFrameSeq = inspection.frameSeq;
    async function poll() {
      const headers = { "X-Inspection-Token": inspection!.token };
      const response = await fetch(`/api/admin/account-inspections?id=${encodeURIComponent(inspection!.id)}`, { credentials: "include", headers });
      if (!response.ok || stopped) return;
      const body = (await response.json()) as Omit<NonNullable<typeof inspection>, "id" | "token">;
      setInspection((current) => current ? { ...current, ...body } : current);
      if (body.frameSeq > 0 && body.frameSeq !== lastFrameSeq) {
        const frame = await fetch(`/api/admin/account-inspections?id=${encodeURIComponent(inspection!.id)}&frame=1`, { credentials: "include", headers, cache: "no-store" });
        if (frame.ok && !stopped) {
          const next = URL.createObjectURL(await frame.blob());
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = next;
          lastFrameSeq = body.frameSeq;
          setFrameUrl(next);
        }
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 850);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, inspection?.id, inspection?.token]);

  useEffect(() => {
    if (!inspection) return;
    const release = () => {
      const payload = JSON.stringify({
        action: "command",
        id: inspection.id,
        token: inspection.token,
        command: { type: "close" },
      });
      navigator.sendBeacon("/api/admin/account-inspections", new Blob([payload], { type: "application/json" }));
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [inspection?.id, inspection?.token]);

  async function start() {
    setStarting(true);
    setError("");
    try {
      const response = await fetch("/api/admin/account-inspections", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", accountId: account.id, mode }),
      });
      const body = (await response.json()) as { ok?: boolean; inspectionId?: string; token?: string; error?: string };
      if (!response.ok || !body.ok || !body.inspectionId || !body.token) throw new Error(body.error || "登录态查看启动失败");
      setInspection({ id: body.inspectionId, token: body.token, status: "queued", frameSeq: 0, pageUrl: "", pageTitle: "", observedIp: null, viewportWidth: 1365, viewportHeight: 900 });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录态查看启动失败");
    } finally {
      setStarting(false);
    }
  }

  async function closeInspection() {
    if (inspection) await command({ type: "close" }).catch(() => undefined);
  }

  return (
    <Dialog open={open} onOpenChange={(value) => {
      if (!value) void closeInspection();
      setOpen(value);
      if (!value) {
        setInspection(null);
        setFrameUrl("");
      }
    }}>
      <DialogTrigger asChild><Button variant="secondary" size="sm">打开当前登录态</Button></DialogTrigger>
      <DialogContent title={`当前登录态 · ${account.email}`} className="w-[min(96vw,100rem)] max-w-none">
        {!inspection ? (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted">系统将锁定当前账号，使用已保存 Session 和原 sticky 代理打开平台。不会把 Cookie 或浏览器调试端口发送到前端。</p>
            <Field label="打开模式"><Select value={mode} onValueChange={(value) => setMode(value as typeof mode)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="view">查看模式（只允许滚动、刷新、前进后退）</SelectItem><SelectItem value="maintenance">维护模式（允许点击和输入，可重新登录）</SelectItem></SelectContent></Select></Field>
            <div className="rounded-md border border-border bg-elevated p-3 text-xs text-subtle">生产环境必须通过 HTTPS 打开管理台；普通 HTTP 会被服务器拒绝。页面关闭或失联约 90 秒会自动释放账号，单次查看最长 30 分钟。</div>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <Button className="w-full" disabled={starting} onClick={() => void start()}>{starting ? "正在分配安全浏览器…" : "安全打开"}</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-elevated px-3 py-2 text-xs">
              <div><Badge tone={inspection.status === "active" ? "ok" : inspection.status === "failed" ? "danger" : "info"}>{inspection.status}</Badge><span className="ml-2 text-muted">{inspection.pageTitle || "正在打开平台…"}</span></div>
              <div className="font-mono text-subtle">出口 {inspection.observedIp || "检测中"}</div>
            </div>
            <p className="truncate font-mono text-[11px] text-subtle">{inspection.pageUrl || "等待页面地址"}</p>
            <div className="relative min-h-80 overflow-auto rounded-lg border border-border bg-black">
              {frameUrl ? (
                <img
                  src={frameUrl}
                  alt="账号当前登录态远程画面"
                  className={`mx-auto block h-auto max-h-[70vh] max-w-full select-none ${mode === "maintenance" ? "cursor-crosshair" : ""}`}
                  draggable={false}
                  onClick={(event) => {
                    if (mode !== "maintenance") return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const x = Math.round(((event.clientX - rect.left) / rect.width) * inspection.viewportWidth);
                    const y = Math.round(((event.clientY - rect.top) / rect.height) * inspection.viewportHeight);
                    void command({ type: "click", x, y }).catch((reason) => toast.error(reason.message));
                  }}
                />
              ) : <div className="grid min-h-80 place-items-center text-sm text-white/60">正在启动原登录态浏览器并获取安全画面…</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void command({ type: "scroll", deltaY: -700 })}>向上滚动</Button>
              <Button variant="secondary" size="sm" onClick={() => void command({ type: "scroll", deltaY: 700 })}>向下滚动</Button>
              <Button variant="secondary" size="sm" onClick={() => void command({ type: "back" })}>后退</Button>
              <Button variant="secondary" size="sm" onClick={() => void command({ type: "forward" })}>前进</Button>
              <Button variant="secondary" size="sm" onClick={() => void command({ type: "reload" })}>刷新</Button>
              <Button variant="destructive" size="sm" onClick={() => void closeInspection()}>关闭会话</Button>
            </div>
            {mode === "maintenance" ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="先在画面点击输入框，再从这里发送文字" />
                <Button variant="secondary" onClick={() => void command({ type: "type", text }).then(() => setText(""))}>输入文字</Button>
                <Button variant="secondary" onClick={() => void command({ type: "key", key: "Enter" })}>Enter</Button>
                <Button variant="secondary" onClick={() => void command({ type: "key", key: "Tab" })}>Tab</Button>
                <Button variant="secondary" onClick={() => void command({ type: "key", key: "Escape" })}>Esc</Button>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-subtle">{label}</dt><dd className="mt-0.5 break-all text-muted">{value}</dd></div>;
}

function AddDialog() {
  const proxies = useGateway((s) => s.proxies);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [remark, setRemark] = useState("");
  const [batch, setBatch] = useState("");
  const [tags, setTags] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [platform, setPlatform] = useState<Platform>("chatgpt");
  const [proxyId, setProxyId] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!email.trim()) {
      toast.error("请填写邮箱");
      return;
    }
    const state = useGateway.getState();
    const normalizedEmail = email.trim();
    if (
      state.accounts.some(
        (account) =>
          account.platform === platform && account.email.toLowerCase() === normalizedEmail.toLowerCase(),
      )
    ) {
      toast.error("该平台已存在这个账号");
      return;
    }
    const account = createPendingAccount({
      platform,
      email: normalizedEmail,
      remark,
      proxyId: proxyId || null,
    });
    account.batch = batch.trim();
    account.tags = tags.split(",").map((item) => item.trim()).filter(Boolean);
    account.expiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
    const nextAccounts = [account, ...state.accounts];
    setSaving(true);
    const saved = await persistControlPlane({
      accounts: nextAccounts,
      proxies: state.proxies,
      settings: state.settings,
    });
    setSaving(false);
    if (!saved.ok) {
      toast.error(saved.error);
      return;
    }
    useGateway.setState({ accounts: nextAccounts });
    toast.success("账号已保存。下一步：绑定代理，再点登录");
    setEmail("");
    setRemark("");
    setBatch("");
    setTags("");
    setExpiresAt("");
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>添加账号</Button>
      </DialogTrigger>
      <DialogContent title="添加账号">
        <div className="space-y-3">
          <Field label="平台">
            <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chatgpt">ChatGPT · LLM / Vision</SelectItem>
                <SelectItem value="gemini">Gemini · Image</SelectItem>
                <SelectItem value="leonardo">Leonardo · Image</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="邮箱">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@mail.test" />
          </Field>
          <Field label="备注">
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} />
          </Field>
          <Field label="批次">
            <Input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="例如 2026-08-A" />
          </Field>
          <Field label="标签（英文逗号分隔）">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="VIP, 图像账号" />
          </Field>
          <Field label="业务到期时间">
            <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
          <Field label="绑定代理">
            <Select value={proxyId || "none"} onValueChange={(v) => setProxyId(v === "none" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="可选" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">暂不绑定</SelectItem>
                {proxies.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button className="w-full" disabled={saving} onClick={() => void submit()}>
            {saving ? "保存中…" : "加入池"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog() {
  const importAccounts = useGateway((s) => s.importAccounts);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("chatgpt,new.one@mail.test,批次A\ngemini,new.two@mail.test,批次A\nleonardo,new.three@mail.test,批次A");

  function submit() {
    const rows = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [p, email, remark] = line.split(",").map((s) => s.trim());
        const platform: Platform = p === "gemini" ? "gemini" : p === "leonardo" ? "leonardo" : "chatgpt";
        return { platform, email: email ?? "", remark };
      });
    const n = importAccounts(rows);
    toast.success(`已导入 ${n} 个账号`);
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">批量导入</Button>
      </DialogTrigger>
      <DialogContent title="批量导入">
        <p className="mb-3 text-sm text-muted">每行：platform,email,备注</p>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} />
        <Button className="mt-4 w-full" onClick={submit}>
          导入
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function LoginDialog({ account }: { account: Account }) {
  const captureSession = useGateway((s) => s.captureSession);
  const bindProxy = useGateway((s) => s.bindProxy);
  const proxies = useGateway((s) => s.proxies);
  const enforceProxy = useGateway((s) => s.settings.enforceProxy);
  const [open, setOpen] = useState(false);
  const [proxyId, setProxyId] = useState(account.proxyId ?? "");
  const [tab, setTab] = useState<"file" | "demo">("file");
  const [error, setError] = useState("");
  const [packing, setPacking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [proxyPassword, setProxyPassword] = useState("");
  const [diagnosis, setDiagnosis] = useState("");

  const bound = Boolean(account.proxyId);
  const activeProxies = proxies.filter((p) => p.status === "active");
  const proxy = proxies.find((p) => p.id === account.proxyId) ?? null;
  const site = account.platform === "gemini" ? "Gemini" : account.platform === "leonardo" ? "Leonardo" : "ChatGPT";

  useEffect(() => {
    if (!open || account.platform !== "leonardo") {
      setDiagnosis("");
      return;
    }
    let cancelled = false;
    void diagnoseSessionFile({ data: { accountId: account.id, platform: "leonardo" } }).then((row) => {
      if (cancelled) return;
      if (row.ok) {
        setDiagnosis(`当前登录文件可用，已有 Session Cookie${row.authNames?.length ? `（${row.authNames.slice(0, 3).join("、")}）` : ""}。`);
        return;
      }
      const names = (row.cookieNames || []).join("、") || "无";
      setDiagnosis(row.error || row.reason || `登录文件无效。Cookie：${names}`);
    });
    return () => {
      cancelled = true;
    };
  }, [open, account.id, account.platform]);

  function bind() {
    setError("");
    const r = bindProxy(account.id, proxyId || null);
    if (!r.ok) {
      setError(r.error);
      toast.error(r.error);
    } else toast.success("代理已绑定");
  }

  function save(source: "demo" | "pasted", payload?: string) {
    setError("");
    if (enforceProxy && !account.proxyId) {
      setError("先绑定 sticky 代理");
      toast.error("先绑定 sticky 代理");
      return;
    }
    const r = captureSession(account.id, source, payload);
    if (!r.ok) {
      setError(r.error);
      toast.error(r.error);
      return;
    }
    toast.success(source === "pasted" ? "已登记登录态（Cookie 未保存在网页里）" : "演示登录已写入");
    setOpen(false);
  }

  async function downloadHelper() {
    if (!proxy) {
      setError("先绑定 sticky 代理，登录必须走同一出口");
      toast.error("先绑定 sticky 代理，登录必须走同一出口");
      return;
    }
    if (proxy.type !== "ss" && proxy.username && !proxyPassword.trim()) {
      setError("填写代理密码后再下载，否则登录会走你本机 IP");
      toast.error("填写代理密码后再下载");
      return;
    }
    setPacking(true);
    try {
      if (proxy.type !== "ss" && proxy.username && proxyPassword.trim()) {
        const res = await fetch("/api/admin/login-pack", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({ accountId: account.id, proxyPassword: proxyPassword.trim() }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `打包失败 ${res.status}`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safeName(account.email)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } else {
        const a = document.createElement("a");
        a.href = `/api/admin/login-pack?accountId=${encodeURIComponent(account.id)}`;
        a.download = `${safeName(account.email)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setProxyPassword("");
      toast.success("登录包很小，已开始下载。第一次运行 run.bat 会从 GitHub 下载代理组件。");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "打包失败";
      setError(msg);
      toast.error(msg);
    } finally {
      setPacking(false);
    }
  }

  function readFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".json")) {
      setError("请拖入登录生成的 json 文件");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const text = String(reader.result ?? "");
      try {
        const saved = await saveSessionFile({ data: { accountId: account.id, json: text, platform: account.platform } });
        if (!saved.ok) {
          setError(saved.error);
          toast.error(saved.error);
          return;
        }
        save("pasted", text);
      } catch (err) {
        setError(err instanceof Error ? err.message : "保存 Session 失败");
      }
    };
    reader.onerror = () => setError("无法读取文件");
    reader.readAsText(file);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          setProxyId(account.proxyId ?? "");
          setTab("file");
          setError("");
          setProxyPassword("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          登录
        </Button>
      </DialogTrigger>
      <DialogContent title={`登录 ${account.email}`} className="max-w-lg">
        <p className="text-sm text-muted">
          平台绑好代理后点「下载一键登录包」。解压双击 run.bat，不用自己对 IP。
          {account.platform === "leonardo"
            ? " 只会弹出一个专用窗口。必须用 Canva 授权：先在 Canva 标签登录国际站（不要用 canva.cn），再在 Leonardo 点 Continue with Canva。授权弹窗不要关。等到 Sign In 消失才保存。公开出图页不算登录。"
            : ""}
        </p>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        {diagnosis && !error && <p className="mt-2 text-sm text-warn">{diagnosis}</p>}

        <div className="mt-4 space-y-2 rounded-md border border-border bg-elevated p-3">
          <p className="text-xs font-medium text-fg">1. 绑定 sticky 代理</p>
          {bound ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                已绑定 {proxy?.name} · {proxy?.host}:{proxy?.port}
              </p>
              {proxy?.username && proxy.type !== "ss" ? (
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder="代理密码（只写入本机脚本，不存网页）"
                  value={proxyPassword}
                  onChange={(e) => setProxyPassword(e.target.value)}
                />
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                className="h-11 flex-1 rounded-sm border border-border bg-surface px-2 text-sm"
                value={proxyId}
                onChange={(e) => setProxyId(e.target.value)}
              >
                <option value="">选择代理</option>
                {activeProxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.region}
                  </option>
                ))}
              </select>
              <Button variant="secondary" onClick={bind} disabled={!proxyId}>
                绑定
              </Button>
            </div>
          )}
        </div>

        <div className="mt-3 space-y-3 rounded-md border border-border bg-elevated p-3">
          <div className="flex gap-2">
            <Button variant={tab === "file" ? "default" : "secondary"} size="sm" onClick={() => setTab("file")}>
              本机登录
            </Button>
            <Button variant={tab === "demo" ? "default" : "secondary"} size="sm" onClick={() => setTab("demo")}>
              演示登录
            </Button>
          </div>

          {tab === "file" ? (
            <>
              <p className="text-xs leading-relaxed text-subtle">
                下载的是压缩包（含 login.py、run.bat
                {proxy?.type === "ss" ? "。第一次运行会从 GitHub 下载 sing-box" : ""}
                ）。解压后先打开 v2rayN 选 Japan 节点，再双击 run.bat。
              </p>
              <Button className="w-full" variant="secondary" onClick={() => void downloadHelper()} disabled={packing}>
                {packing ? "正在下载登录包…" : "下载一键登录包"}
              </Button>
              <label
                className={`flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-3 py-6 text-center text-xs ${
                  dragging ? "border-border-strong bg-surface" : "border-border bg-surface"
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const file = e.dataTransfer.files[0];
                  if (file) readFile(file);
                }}
              >
                <span className="text-muted">把登录文件拖到这里（常见文件名 state.json）</span>
                <span className="mt-1 text-subtle">只数 Cookie，文件内容不留在网页里</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) readFile(file);
                    e.target.value = "";
                  }}
                />
              </label>
            </>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-subtle">
                不打开 {site}。只登记一条空登录态，用来测选号和换号。
              </p>
              <Button className="w-full" onClick={() => save("demo")}>
                写入演示登录
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
