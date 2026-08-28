import type { Account, GatewaySettings, Platform, Proxy } from "./types";
import { nowIso, uid } from "./utils";

export type ControlPlaneWrite = {
  accounts: Account[];
  proxies: Proxy[];
  settings: GatewaySettings;
};

export type ControlPlaneWriteResult =
  | { ok: true }
  | { ok: false; error: string; status?: number };

export function createPendingAccount(data: {
  platform: Platform;
  email: string;
  remark?: string;
  proxyId?: string | null;
}): Account {
  return {
    id: uid(),
    platform: data.platform,
    email: data.email.trim(),
    remark: data.remark?.trim() || "",
    status: "pending_login",
    proxyId: data.proxyId || null,
    sessionPath: null,
    failCount: 0,
    totalRequests: 0,
    lastUsedAt: null,
    createdAt: nowIso(),
    lockedUntil: null,
    lastError: null,
    lastProbeAt: null,
    updatedAt: nowIso(),
    expiresAt: null,
    sessionExpiresAt: null,
    batch: "",
    tags: [],
    loginIp: null,
    lastProbeIp: null,
    ipState: "unknown",
    nextProbeAt: null,
    lastHealthAt: null,
    lastStaticProbeAt: null,
    lastProxyProbeAt: null,
    lastLiveProbeAt: null,
    consecutiveProbeFailures: 0,
    healthScore: 0,
    autoCheck: true,
    inspectionId: null,
  };
}

export async function persistControlPlane(
  plane: ControlPlaneWrite,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<ControlPlaneWriteResult> {
  try {
    const response = await fetcher("/api/admin/plane", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plane),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      skipped?: string;
    };
    if (response.status === 401) {
      return { ok: false, status: 401, error: body.error || "管理员登录已过期，请重新登录" };
    }
    if (!response.ok || !body.ok || body.skipped) {
      return {
        ok: false,
        status: response.status,
        error:
          body.error ||
          (body.skipped ? "服务器拒绝保存：" + body.skipped : "保存失败（HTTP " + response.status + "）"),
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "无法连接服务器保存账号" };
  }
}
