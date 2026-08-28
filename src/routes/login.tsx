import { createFileRoute } from "@tanstack/react-router";
import { Activity, LockKeyhole } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export const Route = createFileRoute("/login")({ component: LoginPage });

function nextDestination() {
  if (typeof window === "undefined") return "/";
  const value = new URLSearchParams(window.location.search).get("next") || "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/login")) return "/";
  return value;
}

function LoginPage() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let stopped = false;
    void fetch("/api/admin/session", { credentials: "include" })
      .then((response) => {
        if (response.ok && !stopped) window.location.replace(nextDestination());
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) setChecking(false);
      });
    return () => {
      stopped = true;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("请输入管理员账号和密码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) {
        setError(body.error || "管理员账号或密码错误");
        return;
      }
      window.location.replace(nextDestination());
    } catch {
      setError("无法连接服务器，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-bg px-4 py-10 text-fg">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.07),transparent_38%)]" />
      <section className="relative w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-2xl shadow-black/30 sm:p-8">
        <div className="mb-8 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl border border-border bg-elevated">
            <Activity className="size-5 text-accent" strokeWidth={1.75} />
          </span>
          <div>
            <p className="font-medium tracking-tight">Relay</p>
            <p className="text-xs text-muted">网页转 API 管理控制台</p>
          </div>
        </div>

        <div className="mb-6">
          <div className="mb-3 grid size-9 place-items-center rounded-lg bg-elevated text-muted">
            <LockKeyhole className="size-4" strokeWidth={1.75} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">登录管理台</h1>
          <p className="mt-1.5 text-sm leading-6 text-muted">请输入管理员账号和密码继续。</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="admin-username">管理员账号</Label>
            <Input
              id="admin-username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={busy || checking}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-password">密码</Label>
            <Input
              id="admin-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy || checking}
              autoFocus
            />
          </div>
          {error && (
            <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" className="h-11 w-full" disabled={busy || checking}>
            {checking ? "正在检查会话…" : busy ? "正在登录…" : "登录"}
          </Button>
        </form>

        <p className="mt-6 text-center text-[11px] leading-5 text-subtle">登录信息仅用于创建安全的管理会话。</p>
      </section>
    </main>
  );
}
