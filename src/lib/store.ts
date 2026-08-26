import { create } from "zustand";
import { persist } from "zustand/middleware";
import { defaultSelectors, listEligible, proxyCapacity } from "./eligibility";
import { parseStorageState } from "./session-file";
import type {
  Account,
  AccountStatus,
  GatewaySettings,
  OpResult,
  Platform,
  Proxy,
  RequestLog,
  WorkerNode,
} from "./types";
import { nowIso, uid } from "./utils";
import { seedAccounts, seedLogs, seedProxies, seedWorkers } from "./seed";

type State = {
  accounts: Account[];
  proxies: Proxy[];
  logs: RequestLog[];
  workers: WorkerNode[];
  settings: GatewaySettings;
  hydrated: boolean;
};

type Actions = {
  setHydrated: (v: boolean) => void;
  addAccount: (data: Pick<Account, "platform" | "email" | "remark" | "proxyId">) => Account;
  updateAccount: (id: string, patch: Partial<Account>) => void;
  deleteAccount: (id: string) => void;
  importAccounts: (rows: { platform: Platform; email: string; remark?: string }[]) => number;
  bindProxy: (accountId: string, proxyId: string | null) => OpResult;
  captureSession: (id: string, source?: "demo" | "pasted", payload?: string) => OpResult;
  promoteHealthy: (id: string) => OpResult;
  addProxy: (data: Omit<Proxy, "id" | "createdAt">) => Proxy;
  updateProxy: (id: string, patch: Partial<Proxy>) => void;
  deleteProxy: (id: string) => void;
  addLog: (log: Omit<RequestLog, "id" | "createdAt">) => void;
  clearLogs: () => void;
  markAccountUsed: (id: string, ok: boolean, failThreshold: number, error?: string) => void;
  pickHealthy: (platform: Platform, excludeIds?: string[]) => Account | null;
  lockAccount: (id: string, ms: number) => OpResult;
  unlockAccount: (id: string) => void;
  probeAccount: (id: string) => OpResult;
  probeHealthy: () => { checked: number; demoted: number };
  beatWorkers: () => void;
  updateSettings: (patch: Partial<GatewaySettings>) => void;
  resetDemo: () => void;
};

export const defaultSettings: GatewaySettings = {
  maxRetry: 3,
  failThreshold: 5,
  coolDownSeconds: 300,
  intervalMinMs: 800,
  intervalMaxMs: 2500,
  concurrencyPerWorker: 3,
  enforceProxy: true,
  replyTimeoutMs: 90000,
  allowPreviewFallback: false,
  chatgptSelectors: defaultSelectors.chatgpt,
  geminiSelectors: defaultSelectors.gemini,
};

function initial(): Omit<State, "hydrated"> {
  return {
    accounts: [],
    proxies: [],
    logs: [],
    workers: [],
    settings: defaultSettings,
  };
}

export const useGateway = create<State & Actions>()(
  persist(
    (set, get) => ({
      ...initial(),
      hydrated: true,
      setHydrated: (v) => set({ hydrated: v }),
      addAccount: (data) => {
        const account: Account = {
          id: uid(),
          platform: data.platform,
          email: data.email,
          remark: data.remark,
          status: "pending_login",
          proxyId: data.proxyId,
          sessionPath: null,
          failCount: 0,
          totalRequests: 0,
          lastUsedAt: null,
          createdAt: nowIso(),
          lockedUntil: null,
          lastError: null,
          lastProbeAt: null,
        };
        set({ accounts: [account, ...get().accounts] });
        return account;
      },
      updateAccount: (id, patch) =>
        set({
          accounts: get().accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        }),
      deleteAccount: (id) =>
        set({ accounts: get().accounts.filter((a) => a.id !== id) }),
      importAccounts: (rows) => {
        const created = rows
          .filter((r) => r.email.trim())
          .map((r) => ({
            id: uid(),
            platform: r.platform,
            email: r.email.trim(),
            remark: r.remark?.trim() ?? "",
            status: "pending_login" as AccountStatus,
            proxyId: null,
            sessionPath: null,
            failCount: 0,
            totalRequests: 0,
            lastUsedAt: null,
            createdAt: nowIso(),
            lockedUntil: null,
            lastError: null,
            lastProbeAt: null,
          }));
        set({ accounts: [...created, ...get().accounts] });
        return created.length;
      },
      bindProxy: (accountId, proxyId) => {
        if (proxyId) {
          const proxy = get().proxies.find((p) => p.id === proxyId);
          if (!proxy) return { ok: false, error: "代理不存在" };
          if (proxy.status !== "active") return { ok: false, error: "代理已停用" };
          const used = proxyCapacity(proxy, get().accounts.filter((a) => a.id !== accountId));
          if (used >= proxy.maxAccounts) {
            return { ok: false, error: `该 sticky IP 已满（${proxy.maxAccounts}）` };
          }
        }
        set({
          accounts: get().accounts.map((a) =>
            a.id === accountId ? { ...a, proxyId } : a,
          ),
        });
        return { ok: true };
      },
      captureSession: (id, source = "demo", payload) => {
        let cookieCount = 0;
        if (source === "pasted") {
          const account = get().accounts.find((a) => a.id === id);
          const parsed = parseStorageState(payload ?? "", account?.platform);
          if (!parsed.ok) return parsed;
          cookieCount = parsed.data.cookieCount;
        }
        const promoted = get().promoteHealthy(id);
        if (!promoted.ok) return promoted;
        set({
          accounts: get().accounts.map((a) =>
            a.id === id
              ? {
                  ...a,
                  sessionPath: `storage/sessions/${id}.json`,
                  sessionCookieCount: source === "pasted" ? cookieCount : a.sessionCookieCount ?? 0,
                  sessionSavedAt: nowIso(),
                  lastError: null,
                  sessionWarning: null,
                }
              : a,
          ),
        });
        return { ok: true };
      },
      promoteHealthy: (id) => {
        const account = get().accounts.find((a) => a.id === id);
        if (!account) return { ok: false, error: "账号不存在" };
        const { settings, proxies } = get();
        if (settings.enforceProxy) {
          const p = proxies.find((x) => x.id === account.proxyId);
          if (!p || p.status !== "active") {
            return { ok: false, error: "必须先绑定启用中的 sticky 代理" };
          }
        }
        set({
          accounts: get().accounts.map((a) =>
            a.id === id
              ? {
                  ...a,
                  status: "healthy",
                  failCount: 0,
                  lastError: null,
                  sessionPath: a.sessionPath ?? `storage/sessions/${id}.json`,
                  lastUsedAt: nowIso(),
                }
              : a,
          ),
        });
        return { ok: true };
      },
      addProxy: (data) => {
        const proxy: Proxy = { ...data, id: uid(), createdAt: nowIso() };
        set({ proxies: [proxy, ...get().proxies] });
        return proxy;
      },
      updateProxy: (id, patch) =>
        set({
          proxies: get().proxies.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        }),
      deleteProxy: (id) =>
        set({
          proxies: get().proxies.filter((p) => p.id !== id),
          accounts: get().accounts.map((a) =>
            a.proxyId === id ? { ...a, proxyId: null, status: a.status === "healthy" ? "cooling" : a.status } : a,
          ),
        }),
      addLog: (log) =>
        set({
          logs: [{ ...log, id: uid(), createdAt: nowIso() }, ...get().logs].slice(0, 400),
        }),
      clearLogs: () => set({ logs: [] }),
      markAccountUsed: (id, ok, failThreshold, error) =>
        set({
          accounts: get().accounts.map((a) => {
            if (a.id !== id) return a;
            if (ok) {
              return {
                ...a,
                failCount: 0,
                totalRequests: a.totalRequests + 1,
                lastUsedAt: nowIso(),
                lastError: null,
                lockedUntil: null,
                status: "healthy",
              };
            }
            const failCount = a.failCount + 1;
            const cooling =
              failCount >= failThreshold
                ? "invalid"
                : a.status;
            return {
              ...a,
              failCount,
              totalRequests: a.totalRequests + 1,
              lastUsedAt: nowIso(),
              lastError: error ?? "请求失败",
              lockedUntil: null,
              status: cooling,
            };
          }),
        }),
      pickHealthy: (platform, excludeIds = []) => {
        const { accounts, proxies, settings } = get();
        return listEligible(accounts, proxies, settings, platform, excludeIds)[0] ?? null;
      },
      lockAccount: (id, ms) => {
        const account = get().accounts.find((a) => a.id === id);
        if (!account) return { ok: false, error: "账号不存在" };
        if (account.lockedUntil && new Date(account.lockedUntil).getTime() > Date.now()) {
          return { ok: false, error: "账号占用中" };
        }
        const until = new Date(Date.now() + ms).toISOString();
        set({
          accounts: get().accounts.map((a) =>
            a.id === id ? { ...a, lockedUntil: until } : a,
          ),
        });
        return { ok: true };
      },
      unlockAccount: (id) =>
        set({
          accounts: get().accounts.map((a) =>
            a.id === id ? { ...a, lockedUntil: null } : a,
          ),
        }),
      probeAccount: (id) => {
        const { accounts, proxies, settings } = get();
        const account = accounts.find((a) => a.id === id);
        if (!account) return { ok: false, error: "账号不存在" };
        const sessionOk = Boolean(account.sessionPath);
        const proxy = proxies.find((p) => p.id === account.proxyId);
        const proxyOk = !settings.enforceProxy || (proxy && proxy.status === "active");
        const ok = sessionOk && proxyOk;
        set({
          accounts: get().accounts.map((a) => {
            if (a.id !== id) return a;
            if (ok) {
              return { ...a, lastProbeAt: nowIso(), lastError: null };
            }
            return {
              ...a,
              lastProbeAt: nowIso(),
              lastError: !sessionOk ? "探活失败：Session 缺失" : "探活失败：代理不可用",
              status: a.status === "healthy" ? "invalid" : a.status,
            };
          }),
        });
        return ok ? { ok: true } : { ok: false, error: "探活失败，已摘除" };
      },
      probeHealthy: () => {
        const ids = get()
          .accounts.filter((a) => a.status === "healthy")
          .map((a) => a.id);
        let demoted = 0;
        for (const id of ids) {
          const r = get().probeAccount(id);
          if (!r.ok) demoted += 1;
        }
        return { checked: ids.length, demoted };
      },
      beatWorkers: () =>
        set({
          workers: get().workers.map((w) => ({
            ...w,
            lastBeat: nowIso(),
            concurrency: w.online ? Math.floor(Math.random() * 4) : 0,
          })),
        }),
      updateSettings: (patch) =>
        set({ settings: { ...get().settings, ...patch } }),
      resetDemo: () => {
        if (process.env.RELAY_DEMO_MODE === "true") set({ ...initial(), ...{ accounts: seedAccounts(), proxies: seedProxies(), logs: seedLogs(), workers: seedWorkers() } });
      },
    }),
    {
      name: "relay-gateway-v2",
      partialize: (s) => ({ logs: s.logs }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>;
        return { ...current, logs: p.logs ?? current.logs };
      },
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true);
      },
    },
  ),
);
