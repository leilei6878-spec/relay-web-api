import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { ProxyStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { probeProxy } from "@/lib/gateway";
import { parseShareLink } from "@/lib/proxy-link";
import { useGateway } from "@/lib/store";
import type { Proxy, ProxyType } from "@/lib/types";
import { formatTime } from "@/lib/utils";

export const Route = createFileRoute("/proxies")({ component: Page });

function Page() {
  return (
    <AppShell>
      <ProxiesView />
    </AppShell>
  );
}

function ProxiesView() {
  const proxies = useGateway((s) => s.proxies);
  const accounts = useGateway((s) => s.accounts);
  const updateProxy = useGateway((s) => s.updateProxy);
  const deleteProxy = useGateway((s) => s.deleteProxy);
  const [testing, setTesting] = useState<string | null>(null);

  async function testOne(p: Proxy) {
    setTesting(p.id);
    try {
      const res = await probeProxy({
        data: {
          type: p.type,
          host: p.host,
          port: p.port,
          username: p.username,
          password: p.password,
          localPort: p.localPort,
        },
      });
      if (res.ok) {
        updateProxy(p.id, {
          lastCheckAt: new Date().toISOString(),
          lastCheckIp: res.ip ?? null,
          lastCheckMs: "portMs" in res ? (res.portMs ?? null) : null,
          lastCheckError: res.tunnelOk === false ? (res.error ?? null) : null,
          lastCheckSource: "server",
          lastCheckPortOk: true,
          lastCheckTunnelOk: Boolean(res.tunnelOk),
        });
        toast.success(
          res.tunnelOk && res.ip
            ? `节点通 · 出口 ${res.ip}`
            : `节点 ${p.host}:${p.port} 通 · TCP ${"portMs" in res ? res.portMs : ""}ms`,
        );
      } else {
        updateProxy(p.id, {
          lastCheckAt: new Date().toISOString(),
          lastCheckIp: null,
          lastCheckMs: "portMs" in res ? (res.portMs ?? null) : null,
          lastCheckError: res.error,
          lastCheckSource: "server",
          lastCheckPortOk: false,
          lastCheckTunnelOk: false,
        });
        toast.error(res.error);
      }
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">代理</h1>
          <p className="mt-1 text-sm text-muted">
            测试连通先打该节点主机和端口，再尝试出网。端口通则节点在线。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ImportLink />
          <AddProxy />
        </div>
      </header>

      <div className="grid gap-4">
        {proxies.map((p) => {
          const bound = accounts.filter((a) => a.proxyId === p.id);
          return (
            <article key={p.id} className="rounded-xl border border-border bg-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-medium">{p.name}</h2>
                    <ProxyStatusBadge status={p.status} />
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted">
                    {p.type === "ss"
                      ? `ss ${p.method || ""} · ${p.host}:${p.port} → socks5://127.0.0.1:${p.localPort || 10808}`
                      : `${p.type}://${p.host}:${p.port} · ${p.region}`}
                  </p>
                  <p className="mt-1 text-xs text-subtle">sticky {p.stickySessionId}</p>
                  {p.lastCheckAt && (
                    <p className={`mt-2 text-xs ${p.lastCheckPortOk === false ? "text-danger" : "text-muted"}`}>
                      {p.lastCheckPortOk === false
                        ? `节点不通 · ${p.lastCheckError}`
                        : p.lastCheckTunnelOk && p.lastCheckIp
                          ? `节点通 · 出口 ${p.lastCheckIp} · ${p.lastCheckMs}ms · ${formatTime(p.lastCheckAt)}`
                          : `节点 ${p.host}:${p.port} 通 · TCP ${p.lastCheckMs}ms · ${formatTime(p.lastCheckAt)}`}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => testOne(p)} disabled={testing === p.id}>
                    {testing === p.id ? "探测中…" : "测试连通"}
                  </Button>
                  <EditProxy proxy={p} />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      updateProxy(p.id, { status: p.status === "active" ? "disabled" : "active" })
                    }
                  >
                    {p.status === "active" ? "停用" : "启用"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => deleteProxy(p.id)}>
                    删除
                  </Button>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between text-xs text-muted">
                <span>
                  绑定 {bound.length}/{p.maxAccounts}
                </span>
                <span>{p.remark}</span>
              </div>
              {bound.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {bound.map((a) => (
                    <li key={a.id} className="rounded-full bg-elevated px-2.5 py-1 font-mono text-[11px]">
                      {a.email}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

type FormState = {
  name: string;
  host: string;
  port: string;
  type: ProxyType;
  region: string;
  sticky: string;
  username: string;
  password: string;
  maxAccounts: string;
  remark: string;
  method: string;
  localPort: string;
};

function emptyForm(): FormState {
  return {
    name: "",
    host: "",
    port: "7777",
    type: "http",
    region: "JP-Tokyo",
    sticky: "",
    username: "",
    password: "",
    maxAccounts: "6",
    remark: "",
    method: "",
    localPort: "10808",
  };
}

function fromProxy(p: Proxy): FormState {
  return {
    name: p.name,
    host: p.host,
    port: String(p.port),
    type: p.type,
    region: p.region,
    sticky: p.stickySessionId,
    username: p.username,
    password: "",
    maxAccounts: String(p.maxAccounts),
    remark: p.remark,
    method: p.method ?? "",
    localPort: String(p.localPort || 10808),
  };
}

function toPayload(f: FormState, keepPassword?: string) {
  return {
    name: f.name.trim(),
    type: f.type,
    host: f.host.trim(),
    port: Number(f.port) || 7777,
    username: f.username,
    password: f.password || keepPassword || "",
    stickySessionId: f.sticky.trim() || `sess-${Date.now()}`,
    region: f.region.trim(),
    status: "active" as const,
    maxAccounts: Number(f.maxAccounts) || 6,
    remark: f.remark.trim(),
    method: f.type === "ss" ? f.method || "2022-blake3-aes-256-gcm" : undefined,
    localPort: f.type === "ss" ? Number(f.localPort) || 10808 : undefined,
  };
}

function ProxyFields({
  form,
  setForm,
  passwordHint,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  passwordHint?: string;
}) {
  function patch(p: Partial<FormState>) {
    setForm({ ...form, ...p });
  }
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>名称</Label>
        <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>类型</Label>
          <Select value={form.type} onValueChange={(v) => patch({ type: v as ProxyType })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">HTTP</SelectItem>
              <SelectItem value="socks5">SOCKS5</SelectItem>
              <SelectItem value="ss">Shadowsocks</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>端口</Label>
          <Input value={form.port} onChange={(e) => patch({ port: e.target.value })} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>主机</Label>
        <Input value={form.host} onChange={(e) => patch({ host: e.target.value })} placeholder="res.example.net" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>地区</Label>
          <Input value={form.region} onChange={(e) => patch({ region: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label>最多绑号</Label>
          <Input value={form.maxAccounts} onChange={(e) => patch({ maxAccounts: e.target.value })} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Sticky Session ID</Label>
        <Input value={form.sticky} onChange={(e) => patch({ sticky: e.target.value })} placeholder="自动生成" />
      </div>
      {form.type === "ss" ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>加密</Label>
            <Input value={form.method} onChange={(e) => patch({ method: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>本机 SOCKS 端口</Label>
            <Input value={form.localPort} onChange={(e) => patch({ localPort: e.target.value })} />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>用户名</Label>
            <Input value={form.username} onChange={(e) => patch({ username: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>密码</Label>
            <Input
              type="password"
              autoComplete="off"
              value={form.password}
              onChange={(e) => patch({ password: e.target.value })}
              placeholder={passwordHint}
            />
          </div>
        </div>
      )}
      {form.type === "ss" && (
        <div className="space-y-1.5">
          <Label>密码 / 密钥</Label>
          <Input
            type="password"
            autoComplete="off"
            value={form.password}
            onChange={(e) => patch({ password: e.target.value })}
            placeholder={passwordHint}
          />
        </div>
      )}
      <div className="space-y-1.5">
        <Label>备注</Label>
        <Input value={form.remark} onChange={(e) => patch({ remark: e.target.value })} />
      </div>
    </div>
  );
}

function AddProxy() {
  const addProxy = useGateway((s) => s.addProxy);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

  function submit() {
    if (!form.name.trim() || !form.host.trim()) {
      toast.error("请填写名称与主机");
      return;
    }
    addProxy(toPayload(form));
    toast.success("代理已加入");
    setOpen(false);
    setForm(emptyForm());
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>添加代理</Button>
      </DialogTrigger>
      <DialogContent title="添加 sticky 代理">
        <ProxyFields form={form} setForm={setForm} />
        <Button className="mt-4 w-full" onClick={submit}>
          保存
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function EditProxy({ proxy }: { proxy: Proxy }) {
  const updateProxy = useGateway((s) => s.updateProxy);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(() => fromProxy(proxy));

  function submit() {
    if (!form.name.trim() || !form.host.trim()) {
      toast.error("请填写名称与主机");
      return;
    }
    const payload = toPayload(form, proxy.password);
    updateProxy(proxy.id, payload);
    toast.success("已保存修改");
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setForm(fromProxy(proxy));
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          修改
        </Button>
      </DialogTrigger>
      <DialogContent title={`修改 ${proxy.name}`}>
        <ProxyFields form={form} setForm={setForm} passwordHint="留空则不改密码" />
        <Button className="mt-4 w-full" onClick={submit}>
          保存修改
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function ImportLink() {
  const addProxy = useGateway((s) => s.addProxy);
  const proxies = useGateway((s) => s.proxies);
  const [open, setOpen] = useState(false);
  const [uri, setUri] = useState("");

  const preview = uri.trim() ? parseShareLink(uri) : null;

  function applyUri(value: string) {
    setUri(value);
  }

  function submit() {
    const parsed = parseShareLink(uri);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    if (proxies.some((p) => p.host === parsed.data.host && p.port === parsed.data.port)) {
      toast.error("这个节点已经在池里");
      return;
    }
    addProxy(parsed.data);
    toast.success(`已导入 ${parsed.data.name}（${parsed.data.host}:${parsed.data.port}）`);
    setUri("");
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">导入分享链接</Button>
      </DialogTrigger>
      <DialogContent title="导入 ss:// 节点">
        <p className="text-sm text-muted">
          请粘贴<strong>整行</strong>，必须带 <code>@主机:端口</code>。从 v2rayN 复制分享链接，不要只复制二维码下面截断的前半段。
        </p>
        <Textarea
          className="mt-3 font-mono text-xs break-all"
          value={uri}
          onChange={(e) => applyUri(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (text) {
              e.preventDefault();
              applyUri(text);
            }
          }}
          placeholder={"ss://…@1.2.3.4:8443#名称"}
          rows={5}
        />
        {preview && preview.ok && (
          <p className="mt-2 text-sm text-ok">
            将导入 {preview.data.name} · {preview.data.host}:{preview.data.port} · {preview.data.method}
          </p>
        )}
        {preview && !preview.ok && <p className="mt-2 text-sm text-danger">{preview.error}</p>}
        <Button className="mt-4 w-full" onClick={submit} disabled={!preview || !preview.ok}>
          导入
        </Button>
      </DialogContent>
    </Dialog>
  );
}
