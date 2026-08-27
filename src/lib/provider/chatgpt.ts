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

const VERSION_TOKEN: Record<string, RegExp> = {
  "gpt-5.6": /gpt-5\.6|\b5\.6\b/,
  latest: /gpt-5\.6|\b5\.6\b/,
  "gpt-5": /gpt-5(?!\.\d)|gpt-5 auto/,
  "gpt-5-thinking": /thinking|\bsol\b/,
  "gpt-4o": /gpt-4o|\b4o\b/,
};

const PRODUCT_ONLY = /^(chatgpt|auto|instant|fast|chatgpt\s*auto|chatgpt\s*instant)$/i;
const WEB_ALIAS = new Set(["chatgpt-web-auto", "chatgpt-web-fast", "chatgpt-web"]);

export function isWebModelAlias(model?: string) {
  return WEB_ALIAS.has(String(model || "").trim().toLowerCase());
}

function profileOf(actual: string) {
  const g = actual.toLowerCase();
  if (g.includes("thinking")) return "thinking";
  if (g.includes("instant") || g.includes("fast")) return "fast";
  if (g.includes("auto")) return "auto";
  return "";
}

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
      models: ["chatgpt-web-auto", "gpt-5.6", "gpt-5", "gpt-5-thinking", "gpt-4o"],
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
    const req = (requested || "").trim();
    const gotRaw = actual || "";
    const got = gotRaw.toLowerCase();
    const profile = profileOf(gotRaw);
    if (isWebModelAlias(req)) {
      return {
        ok: false,
        requested: req,
        actual: gotRaw || "ChatGPT",
        confirmed: false,
        code: "MODEL_SELECTION_UNCONFIRMED",
        profile,
        profileVerified: Boolean(profile),
      };
    }
    if (!got) {
      return { ok: false, requested: req, actual: "", confirmed: false, code: "MODEL_SELECTION_UNCONFIRMED", profile, profileVerified: false };
    }
    if (PRODUCT_ONLY.test(got.trim()) || ( /^(chatgpt)(\s+\d+(\.\d+)?)?(\s+(instant|auto|fast))?$/i.test(got.trim()) && !VERSION_TOKEN["gpt-5.6"].test(got) && req.toLowerCase().includes("5.6") )) {
      if (req.toLowerCase() === "gpt-4o" && !/4o/.test(got)) {
        return { ok: false, requested: req, actual: gotRaw, confirmed: false, code: "MODEL_MISMATCH", profile, profileVerified: Boolean(profile) };
      }
      if (req.toLowerCase() === "gpt-5.6" || req.toLowerCase() === "latest") {
        return { ok: false, requested: req, actual: gotRaw, confirmed: false, code: "MODEL_SELECTION_UNCONFIRMED", profile, profileVerified: Boolean(profile) };
      }
    }
    const token = VERSION_TOKEN[req] || new RegExp(req.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (token.test(got)) {
      return { ok: true, requested: req, actual: gotRaw, confirmed: true, profile, profileVerified: Boolean(profile) };
    }
    if (req.toLowerCase() === "gpt-5.6" || req.toLowerCase() === "latest") {
      if (/gpt-4o|\b4o\b/.test(got)) {
        return { ok: false, requested: req, actual: gotRaw, confirmed: false, code: "MODEL_MISMATCH", profile, profileVerified: Boolean(profile) };
      }
      return { ok: false, requested: req, actual: gotRaw, confirmed: false, code: "MODEL_SELECTION_UNCONFIRMED", profile, profileVerified: Boolean(profile) };
    }
    return { ok: false, requested: req, actual: gotRaw, confirmed: false, code: "MODEL_MISMATCH", profile, profileVerified: Boolean(profile) };
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
