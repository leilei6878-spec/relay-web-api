import { inspectSession } from "../session-probe";
import { detectPageState, errorForPageState } from "./page-state";
import { prepareChatRequest } from "./prompt-map";
import { fingerprint } from "./fingerprint";
import { packFor } from "./selectors";
import type {
  DomFeature,
  ExtractedResult,
  ModelVerdict,
  NormalizedProviderError,
  PageSignals,
  PageState,
  ProviderAdapter,
  ProviderCapabilities,
  StorageState,
} from "./types";

const LABELS: Record<string, string[]> = {
  "gpt-5.6": ["gpt-5.6", "5.6", "5.2", "5.4", "5.5", "chatgpt", "instant", "auto", "gpt-5"],
  latest: ["gpt-5.6", "gpt-5", "5.6", "5.2", "chatgpt", "instant", "auto"],
  "gpt-5": ["gpt-5 auto", "auto", "gpt-5", "chatgpt", "instant"],
  "gpt-5-thinking": ["gpt-5 thinking", "thinking"],
  "gpt-4o": ["gpt-4o", "4o"],
};

export const chatgptAdapter: ProviderAdapter = {
  id: "chatgpt",
  capabilities(): ProviderCapabilities {
    return {
      chat: true,
      vision: true,
      imageGeneration: false,
      imageEdit: false,
      streaming: true,
      multiTurn: true,
      models: ["gpt-5.6", "gpt-5", "gpt-5-thinking", "gpt-4o"],
      maxOutputs: 1,
    };
  },
  selectorPack(version) {
    return packFor("chatgpt", version);
  },
  validateSession(state: StorageState) {
    return inspectSession(JSON.stringify(state), "chatgpt");
  },
  detectPageState(signals: PageSignals) {
    return detectPageState(signals, "chatgpt");
  },
  prepareRequest(input) {
    return prepareChatRequest("chatgpt", { ...input, kind: input.kind || "chat" });
  },
  normalizeError(error, pageState?: PageState) {
    const state = pageState || guessStateFromError(error);
    const mapped = errorForPageState(state, /selector|composer|dom/i.test(error || ""));
    const message = error || mapped.message;
    return {
      code: mapped.code,
      pageState: state,
      fault: mapped.polluteAccountPool ? "account" : "provider",
      message,
      polluteAccountPool: mapped.polluteAccountPool,
    } satisfies NormalizedProviderError;
  },
  verifyModel(requested, actual) {
    const labels = LABELS[requested] || [requested];
    const got = (actual || "").toLowerCase();
    if (!got) {
      return { ok: false, requested, actual: "", confirmed: false, code: "MODEL_SELECTION_UNCONFIRMED" };
    }
    if (labels.some((l) => got.includes(l.toLowerCase()))) {
      return { ok: true, requested, actual: actual || requested, confirmed: true };
    }
    return { ok: false, requested, actual: actual || "", confirmed: false, code: "MODEL_MISMATCH" };
  },
  extractResult(raw) {
    if (!raw.ok) return { ok: false, error: raw.error || "PROVIDER_ERROR" };
    if (raw.mode === "mock") return { ok: false, error: "PROVIDER_ERROR: mock result in live path" };
    const text = (raw.text || "").trim();
    if (!text) return { ok: false, error: "TIMEOUT: empty assistant" };
    if (text.startsWith("MOCK:")) return { ok: false, error: "PROVIDER_ERROR: mock marker" };
    return { ok: true, text };
  },
  fingerprint(features: DomFeature[], packVersion: string) {
    return fingerprint("chatgpt", packVersion, features);
  },
  healthCheck() {
    return { provider: "chatgpt" };
  },
};

function guessStateFromError(error?: string): PageState {
  const t = (error || "").toUpperCase();
  if (t.includes("CHALLENGE")) return "CHALLENGE";
  if (t.includes("LOGIN_REQUIRED") || t.includes("LOGIN WALL")) return "LOGIN_REQUIRED";
  if (t.includes("RATE")) return "RATE_LIMITED";
  if (t.includes("RESTRICTED") || t.includes("BANNED")) return "ACCOUNT_RESTRICTED";
  if (t.includes("DOM")) return "DOM_UNKNOWN";
  return "DOM_UNKNOWN";
}
