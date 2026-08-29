import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/saas/verify")({ component: VerifyEmail });

function VerifyEmail() {
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [message, setMessage] = useState("正在验证邮箱…");
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") || "";
    void fetch("/api/saas/session", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify-email", token }),
    }).then(async (response) => {
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "验证失败");
      setState("ok"); setMessage("邮箱验证成功，现在可以登录客户控制台。");
    }).catch((error) => { setState("error"); setMessage(error instanceof Error ? error.message : "验证链接无效或已经过期"); });
  }, []);
  return <main className="grid min-h-dvh place-items-center bg-bg px-4 text-fg"><section className="w-full max-w-sm rounded-2xl border border-border bg-surface p-7 text-center">{state === "ok" ? <CheckCircle2 className="mx-auto size-10 text-ok" /> : state === "error" ? <XCircle className="mx-auto size-10 text-danger" /> : <span className="mx-auto block size-10 animate-pulse rounded-full bg-elevated" />}<h1 className="mt-5 text-lg font-medium">邮箱验证</h1><p className="mt-2 text-sm text-muted">{message}</p><Button asChild className="mt-6 w-full" variant={state === "ok" ? "default" : "secondary"}><Link to="/saas/login">返回登录</Link></Button></section></main>;
}
