export type ProviderId = "chatgpt" | "gemini";

export type PageState =
  | "AUTHENTICATED"
  | "LOGIN_REQUIRED"
  | "CHALLENGE"
  | "RATE_LIMITED"
  | "ACCOUNT_RESTRICTED"
  | "COMPOSER_READY"
  | "GENERATING"
  | "RESULT_READY"
  | "PROVIDER_ERROR"
  | "DOM_UNKNOWN";

export type ChatRole = "system" | "user" | "assistant";

export type ChatTurn = {
  role: ChatRole;
  text: string;
  images?: string[];
};

export type PageSignals = {
  url?: string;
  html?: string;
  cookieNames?: string[];
  hasComposer?: boolean;
  hasSend?: boolean;
  hasAssistant?: boolean;
  hasStop?: boolean;
  hasLoginForm?: boolean;
  hasCaptcha?: boolean;
  hasRateLimit?: boolean;
  hasRestricted?: boolean;
  hasModelSwitcher?: boolean;
};

export type SessionValidation = {
  ok: boolean;
  reason?: string;
  cookieCount?: number;
  expiresHint?: number;
};

export type StorageState = {
  cookies?: { name?: string; expires?: number; value?: string }[];
  origins?: unknown[];
};

export type PreparedRequest = {
  provider: ProviderId;
  model: string;
  webPrompt: string;
  turns: ChatTurn[];
  images: string[];
  selectorPackVersion: string;
  kind: "chat" | "image" | "edit" | "canary";
};

export type ProviderCapabilities = {
  chat: boolean;
  vision: boolean;
  imageGeneration: boolean;
  imageEdit: boolean;
  streaming: boolean;
  multiTurn: boolean;
  models: string[];
};

export type VersionedSelectorPack = {
  version: string;
  input: string[];
  send: string[];
  assistant: string[];
  streamingStop: string[];
  modelSwitcher?: string[];
  fileInput?: string[];
  imageResult?: string[];
};

export type NormalizedProviderError = {
  code: string;
  pageState: PageState;
  fault: "account" | "provider" | "proxy" | "worker" | "client" | "infra";
  message: string;
  polluteAccountPool: boolean;
};

export type ModelVerdict =
  | { ok: true; requested: string; actual: string; confirmed: true }
  | { ok: false; requested: string; actual: string; confirmed: false; code: "MODEL_MISMATCH" | "MODEL_SELECTION_UNCONFIRMED" };

export type ExtractedResult =
  | { ok: true; text?: string; url?: string; actualModel?: string }
  | { ok: false; error: string };

export type DomFeature = {
  key: string;
  present: boolean;
};

export type Fingerprint = {
  provider: ProviderId;
  packVersion: string;
  hash: string;
  features: DomFeature[];
};

export type ProviderAdapter = {
  id: ProviderId;
  capabilities(): ProviderCapabilities;
  selectorPack(version?: string): VersionedSelectorPack;
  validateSession(state: StorageState): SessionValidation;
  detectPageState(signals: PageSignals): PageState;
  prepareRequest(input: {
    messages?: { role?: string; content?: unknown }[];
    prompt?: string;
    model?: string;
    images?: string[];
    kind?: PreparedRequest["kind"];
  }): PreparedRequest;
  normalizeError(error?: string, pageState?: PageState): NormalizedProviderError;
  verifyModel(requested: string, actual?: string): ModelVerdict;
  extractResult(raw: { text?: string; url?: string; ok?: boolean; error?: string; mode?: string }): ExtractedResult;
  fingerprint(features: DomFeature[], packVersion: string): Fingerprint;
  healthCheck(): { provider: ProviderId };
};
