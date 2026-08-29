import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Cable,
  ClipboardCheck,
  LayoutDashboard,
  Menu,
  Radio,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  TestTube2,
  WalletCards,
  TerminalSquare,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { persistControlPlane } from "@/lib/control-plane-client";
import { nextStep } from "@/lib/readiness";
import { useGateway } from "@/lib/store";

const nav = [
  { to: "/", label: "总览", icon: LayoutDashboard },
  { to: "/accounts", label: "账号池", icon: Users },
  { to: "/proxies", label: "代理", icon: Cable },
  { to: "/playground", label: "试运行", icon: TerminalSquare },
  { to: "/console", label: "API 测试", icon: Radio },
  { to: "/logs", label: "请求日志", icon: ScrollText },
  { to: "/settings", label: "API", icon: Settings2 },
  { to: "/commercial", label: "商业运营", icon: WalletCards },
  { to: "/commercial-config", label: "商业配置", icon: SlidersHorizontal },
  { to: "/commercial-sandbox", label: "供应商沙箱", icon: TestTube2 },
  { to: "/commercial-readiness", label: "发布证据", icon: ClipboardCheck },
];

function redirectToLogin() {
  if (typeof window === "undefined") return;
  const next = `${window.location.pathname}${window.location.search}`;
  const safeNext = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/";
  window.location.replace(`/login?next=${encodeURIComponent(safeNext)}`);
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="flex flex-col gap-1">
      {nav.map((item) => {
        const active = pathname === item.to;
        const Icon = item.icon;
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={cn(
              "flex h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors duration-150",
              active ? "bg-elevated text-fg" : "text-muted hover:bg-elevated/70 hover:text-fg",
            )}
          >
            <Icon className="size-4" strokeWidth={1.75} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const beatWorkers = useGateway((s) => s.beatWorkers);
  const hydrated = useGateway((s) => s.hydrated);
  const setHydrated = useGateway((s) => s.setHydrated);
  const accounts = useGateway((s) => s.accounts);
  const proxies = useGateway((s) => s.proxies);
  const settings = useGateway((s) => s.settings);
  const [open, setOpen] = useState(false);
  const planeSnap = useRef("");
  const planeLoaded = useRef(false);

  const [planeError, setPlaneError] = useState("");
  const [authState, setAuthState] = useState<"checking" | "ok" | "error" | "redirecting">("checking");

  useEffect(() => {
    const unsub = useGateway.persist.onFinishHydration(() => setHydrated(true));
    if (useGateway.persist.hasHydrated()) setHydrated(true);
    const fallback = setTimeout(() => setHydrated(true), 50);
    return () => {
      unsub();
      clearTimeout(fallback);
    };
  }, [setHydrated]);

  useEffect(() => {
    const t = setInterval(beatWorkers, 8000);
    return () => clearInterval(t);
  }, [beatWorkers]);

  useEffect(() => {
    if (!hydrated) return;
    let stop = false;
    async function loadPlane() {
      try {
        await fetch("/api/admin/session", { credentials: "include" });
        const r = await fetch("/api/admin/plane", { credentials: "include" });
        if (r.status === 401) {
          if (!stop) {
            setAuthState("redirecting");
            setPlaneError("管理会话已失效，正在前往登录页…");
            redirectToLogin();
          }
          return;
        }
        const plane = (await r.json()) as { accounts?: typeof accounts; proxies?: typeof proxies; settings?: typeof settings; error?: string };
        if (!plane.accounts) {
          if (!stop) {
            setAuthState("error");
            setPlaneError(plane.error || "服务器没有返回账号数据");
          }
          return;
        }
        if (stop) return;
        if (planeLoaded.current) {
          const cur = useGateway.getState();
          const local = JSON.stringify({ accounts: cur.accounts, proxies: cur.proxies, settings: cur.settings });
          if (local !== planeSnap.current) return;
        }
        useGateway.setState({
          accounts: plane.accounts,
          proxies: plane.proxies || [],
          settings: { ...settings, ...(plane.settings || {}) },
        });
        planeSnap.current = JSON.stringify({
          accounts: plane.accounts,
          proxies: plane.proxies || [],
          settings: { ...settings, ...(plane.settings || {}) },
        });
        planeLoaded.current = true;
        setAuthState("ok");
        setPlaneError("");
      } catch {
        if (!stop) {
          setAuthState("error");
          setPlaneError("无法连接服务器读取账号，请刷新页面重试");
        }
      }
    }
    void loadPlane();
    const t = setInterval(() => void loadPlane(), 15000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated || !planeLoaded.current) return;
    const snap = JSON.stringify({ accounts, proxies, settings });
    if (!planeSnap.current || snap === planeSnap.current) return;
    const t = setTimeout(() => {
      void persistControlPlane({ accounts, proxies, settings }).then((result) => {
        if (result.ok) {
          planeSnap.current = snap;
          setPlaneError("");
          return;
        }
        setPlaneError(result.error);
        if (result.status === 401) {
          setAuthState("redirecting");
          redirectToLogin();
        }
      });
    }, 400);
    return () => clearTimeout(t);
  }, [hydrated, accounts, proxies, settings]);

  if (authState !== "ok") {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg px-4 text-fg">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 text-center shadow-xl shadow-black/20">
          <div className="mx-auto grid size-11 place-items-center rounded-xl border border-border bg-elevated">
            <Activity className="size-5 text-accent" strokeWidth={1.75} />
          </div>
          <p className="mt-4 text-sm font-medium">{authState === "error" ? "管理台暂时不可用" : "正在验证管理会话…"}</p>
          <p className="mt-2 text-xs leading-5 text-muted">{planeError || "请稍候"}</p>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface px-4 py-5 md:flex">
        <Brand />
        <div className="mt-8 flex-1">
          <NavLinks />
        </div>
        <p className="px-1 text-[11px] leading-relaxed text-subtle">{nextStep({ accounts, proxies, settings }).title}</p>
      </aside>

      <div className="md:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-bg/90 px-4 backdrop-blur-sm md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="打开菜单">
              <Menu className="size-5" />
            </Button>
            <SheetContent>
              <Brand />
              <div className="mt-6">
                <NavLinks onNavigate={() => setOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
          <span className="font-medium tracking-tight">Relay</span>
        </header>
        <main className="px-4 py-6 sm:px-6 lg:px-8">
          {planeError && (
            <div className="mb-4 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-danger">
              <p>{planeError}</p>
            </div>
          )}
          {hydrated ? children : <p className="text-sm text-muted">正在载入控制台…</p>}
        </main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <span className="grid size-8 place-items-center rounded-sm border border-border bg-elevated">
        <Activity className="size-4 text-accent" strokeWidth={1.75} />
      </span>
      <div>
        <p className="text-sm font-medium tracking-tight">Relay</p>
        <p className="text-[11px] text-muted">网页转 API 控制台</p>
      </div>
    </div>
  );
}
