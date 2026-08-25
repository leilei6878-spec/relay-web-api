import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Cable,
  LayoutDashboard,
  Menu,
  Radio,
  ScrollText,
  Settings2,
  TerminalSquare,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { saveControlPlane } from "@/lib/gateway";
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
];

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

  useEffect(() => {
    const unsub = useGateway.persist.onFinishHydration(() => setHydrated(true));
    if (useGateway.persist.hasHydrated()) setHydrated(true);
    const fallback = setTimeout(() => setHydrated(true), 800);
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
    const t = setTimeout(() => {
      void saveControlPlane({ data: { accounts, proxies, settings } });
    }, 400);
    return () => clearTimeout(t);
  }, [hydrated, accounts, proxies, settings]);

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
