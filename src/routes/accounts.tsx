import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { AccountStatusBadge, PlatformBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { diagnoseSessionFile, getApiKey, saveSessionFile } from "@/lib/gateway";
import { createPendingAccount, persistControlPlane } from "@/lib/control-plane-client";
import { whyBlocked } from "@/lib/readiness";
import { useGateway } from "@/lib/store";
import { safeName } from "@/lib/session-file";
import type { Account, AccountStatus, Platform } from "@/lib/types";
import { formatTime } from "@/lib/utils";

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

  const filtered = useMemo(
    () =>
      accounts.filter((a) => {
        if (platform !== "all" && a.platform !== platform) return false;
        if (status !== "all" && a.status !== status) return false;
        if (q && !a.email.includes(q) && !a.remark.includes(q)) return false;
        return true;
      }),
    [accounts, platform, status, q],
  );

  const deleteAccount = useGateway((s) => s.deleteAccount);
  const updateAccount = useGateway((s) => s.updateAccount);
  const bindProxy = useGateway((s) => s.bindProxy);

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
          <Button
            variant="secondary"
            onClick={() => {
              void (async () => {
                const key = await getApiKey();
                const res = await fetch("/api/accounts/probe", {
                  method: "POST",
                  headers: { Authorization: `Bearer ${key.apiKey}` },
                });
                const body = (await res.json()) as {
                  checked?: number;
                  demoted?: number;
                  error?: string;
                  details?: { email: string; ok: boolean; reason?: string; warning?: string }[];
                };
                if (!res.ok) toast.error(body.error || "探活失败");
                else {
                  const warn = (body.details || []).filter((d) => d.warning);
                  for (const d of body.details || []) {
                    const acc = useGateway.getState().accounts.find((a) => a.email === d.email);
                    if (!acc) continue;
                    updateAccount(acc.id, {
                      status: d.ok ? "healthy" : "invalid",
                      lastError: d.ok ? null : d.reason || "探活失败",
                      sessionWarning: d.warning || null,
                      lastProbeAt: new Date().toISOString(),
                    });
                  }
                  toast.success(
                    `探活 ${body.checked} 个，摘除 ${body.demoted} 个` +
                      (warn.length ? `；${warn.length} 个登录即将过期` : ""),
                  );
                }
              })();
            }}
          >
            探活健康池
          </Button>
          <ImportDialog />
          <AddDialog />
        </div>
      </header>

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
          placeholder="搜索邮箱或备注"
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
        {selected.length > 0 && (
          <>
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
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[720px] text-left text-sm">
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
              <th className="px-3 py-3 font-medium">平台</th>
              <th className="px-3 py-3 font-medium">状态</th>
              <th className="px-3 py-3 font-medium">调度</th>
              <th className="px-3 py-3 font-medium">代理</th>
              <th className="px-3 py-3 font-medium">请求 / 失败</th>
              <th className="px-3 py-3 font-medium">最近使用</th>
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
                  <p className="font-mono text-xs">{a.email}</p>
                  <p className="text-[11px] text-subtle">{a.remark || "无备注"}</p>
                  {a.sessionWarning && <p className="text-[11px] text-warn">{a.sessionWarning}</p>}
                  {a.lastError && <p className="text-[11px] text-danger">{a.lastError}</p>}
                  {a.platform === "leonardo" && a.tokenState && (
                    <p className="text-[11px] text-subtle">Token {a.tokenState}</p>
                  )}
                  {a.platform === "leonardo" && a.availableModels?.length ? (
                    <p className="text-[11px] text-subtle">模型 {a.availableModels.slice(0, 4).join(" · ")}</p>
                  ) : null}
                  {a.sessionCookieCount ? (
                    <p className="text-[11px] text-subtle">已登记 {a.sessionCookieCount} 枚 Cookie</p>
                  ) : null}
                  {a.platform === "leonardo" && a.status === "pending_login" && (
                    <p className="text-[11px] text-warn">
                      必须用 Canva 授权：Canva 国际站登录后，在 Leonardo 点 Continue with Canva
                    </p>
                  )}
                  {a.lockedUntil && new Date(a.lockedUntil).getTime() > Date.now() && (
                    <p className="text-[11px] text-warn">占用中</p>
                  )}
                </td>
                <td className="px-3 py-3">
                  <PlatformBadge platform={a.platform} />
                </td>
                <td className="px-3 py-3">
                  <AccountStatusBadge status={a.status} />
                </td>
                <td className="px-3 py-3">
                  {whyBlocked(a, proxies, settings) ? (
                    <span className="text-[11px] text-subtle">{whyBlocked(a, proxies, settings)}</span>
                  ) : (
                    <span className="text-[11px] text-muted">可调用</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <select
                    className="h-9 max-w-36 rounded-sm border border-border bg-elevated px-2 text-xs"
                    value={a.proxyId ?? ""}
                    onChange={(e) => {
                      const r = bindProxy(a.id, e.target.value || null);
                      if (!r.ok) toast.error(r.error);
                    }}
                  >
                    <option value="">未绑定</option>
                    {proxies.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-3 font-mono text-xs tabular-nums">
                  {a.totalRequests} / {a.failCount}
                </td>
                <td className="px-3 py-3 text-xs text-muted">{formatTime(a.lastUsedAt)}</td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-1">
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
                    {a.status === "healthy" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const r = useGateway.getState().probeAccount(a.id);
                          if (r.ok) toast.success("探活通过");
                          else toast.error(r.error);
                        }}
                      >
                        探活
                      </Button>
                    )}
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
                <td colSpan={9} className="px-3 py-10 text-center text-sm text-muted">
                  没有匹配的账号
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddDialog() {
  const proxies = useGateway((s) => s.proxies);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [remark, setRemark] = useState("");
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
