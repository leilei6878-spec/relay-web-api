export type Platform = "chatgpt" | "gemini";
export type AccountStatus = "pending_login" | "healthy" | "cooling" | "invalid" | "banned";
export type ProxyStatus = "active" | "disabled";
export type ProxyType = "http" | "socks5" | "ss";
export type LogStatus = "success" | "fail" | "switched";

export type Account = {
  id: string;
  platform: Platform;
  email: string;
  remark: string;
  status: AccountStatus;
  proxyId: string | null;
  sessionPath: string | null;
  failCount: number;
  totalRequests: number;
  lastUsedAt: string | null;
  createdAt: string;
  lockedUntil?: string | null;
  lastError?: string | null;
  lastProbeAt?: string | null;
  sessionCookieCount?: number;
  sessionSavedAt?: string | null;
};

export type Proxy = {
  id: string;
  name: string;
  type: ProxyType;
  host: string;
  port: number;
  username: string;
  password?: string;
  method?: string;
  localPort?: number;
  stickySessionId: string;
  region: string;
  status: ProxyStatus;
  maxAccounts: number;
  remark: string;
  createdAt: string;
  lastCheckAt?: string | null;
  lastCheckIp?: string | null;
  lastCheckMs?: number | null;
  lastCheckError?: string | null;
  lastCheckSource?: "server" | "local" | null;
  lastCheckPortOk?: boolean | null;
  lastCheckTunnelOk?: boolean | null;
};

export type RequestLog = {
  id: string;
  createdAt: string;
  model: string;
  platform: Platform;
  accountId: string | null;
  accountEmail: string;
  latencyMs: number;
  status: LogStatus;
  detail: string;
  promptPreview: string;
};

export type WorkerNode = {
  id: string;
  name: string;
  region: string;
  online: boolean;
  concurrency: number;
  lastBeat: string;
};

export type SelectorPack = {
  input: string[];
  send: string[];
  assistant: string[];
  streamingStop: string[];
};

export type GatewaySettings = {
  maxRetry: number;
  failThreshold: number;
  coolDownSeconds: number;
  intervalMinMs: number;
  intervalMaxMs: number;
  concurrencyPerWorker: number;
  enforceProxy: boolean;
  replyTimeoutMs: number;
  chatgptSelectors: SelectorPack;
  geminiSelectors: SelectorPack;
};

export type OpResult = { ok: true } | { ok: false; error: string };
