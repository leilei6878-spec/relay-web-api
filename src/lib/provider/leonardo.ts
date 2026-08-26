import { inspectSession } from "../session-probe";
import { assertGeneratedImage } from "./image-guard";
import { detectPageState, errorForPageState } from "./page-state";
import {
  GPT_IMAGE_LABELS,
  GEMINI_FAMILY_LABELS,
  accountHasLeonardoModel,
  leonardoBackendMode,
  mapLogicalModel,
  pickGeminiLabel,
} from "./leonardo-models";
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
import type { Account } from "../types";

export const leonardoAdapter: ProviderAdapter = {
  id: "leonardo",
  capabilities(): ProviderCapabilities {
    return {
      chat: false,
      vision: false,
      imageGeneration: true,
      imageEdit: true,
      streaming: false,
      multiTurn: false,
      models: ["leonardo-gpt-image-2", "leonardo-gemini"],
    };
  },
  selectorPack(version) {
    return packFor("leonardo", version);
  },
  validateSession(state: StorageState) {
    return inspectSession(JSON.stringify(state), "leonardo");
  },
  detectPageState(signals: PageSignals) {
    return detectPageState(signals, "leonardo");
  },
  prepareRequest(input) {
    const mapped = mapLogicalModel(input.model || "leonardo-gemini");
    return {
      provider: "leonardo",
      model: mapped.logical,
      webPrompt: input.prompt || "",
      turns: [],
      images: input.images || [],
      selectorPackVersion: "leonardo-image-v1",
      kind: input.kind || "image",
    };
  },
  normalizeError(error, pageState?: PageState) {
    const state = pageState || guessStateFromError(error);
    const mapped = errorForPageState(state, /selector|composer|dom|generate/i.test(error || ""));
    const code = leonardoCode(error, mapped.code);
    return {
      code,
      pageState: state,
      fault: mapped.polluteAccountPool ? "account" : "provider",
      message: error || mapped.message,
      polluteAccountPool: mapped.polluteAccountPool,
    } satisfies NormalizedProviderError;
  },
  verifyModel(requested, actual): ModelVerdict {
    const map = mapLogicalModel(requested);
    const got = (actual || "").toLowerCase();
    if (!got) return { ok: false, requested, actual: "", confirmed: false, code: "MODEL_SELECTION_UNCONFIRMED" };
    const labels = map.logical === "leonardo-gpt-image-2" ? GPT_IMAGE_LABELS : GEMINI_FAMILY_LABELS;
    if (labels.some((l) => got.includes(l.toLowerCase())) || got.includes("nano") || got.includes("gemini") || got.includes("gpt image")) {
      return { ok: true, requested, actual: actual || requested, confirmed: true };
    }
    return { ok: false, requested, actual: actual || "", confirmed: false, code: "MODEL_MISMATCH" };
  },
  extractResult(raw): ExtractedResult {
    if (!raw.ok) return { ok: false, error: raw.error || "LEONARDO_GENERATION_FAILED" };
    if (raw.mode === "mock") return { ok: false, error: "LEONARDO_GENERATION_FAILED: mock forbidden in web_account" };
    const gate = assertGeneratedImage(raw.url, { allowSvg: false });
    if (!gate.ok) return { ok: false, error: gate.error || "LEONARDO_RESULT_NOT_FOUND" };
    return { ok: true, url: gate.url, actualModel: raw.actualModel };
  },
  fingerprint(features: DomFeature[], packVersion: string) {
    return fingerprint("leonardo", packVersion, features);
  },
  healthCheck() {
    return { provider: "leonardo", backend_mode: leonardoBackendMode() };
  },
};

export function listAvailableModels(labels: string[]) {
  const gpt = labels.filter((s) => /gpt image/i.test(s));
  const gemini = labels.filter((s) => /nano|gemini|banana/i.test(s));
  return { gpt, gemini, geminiPick: pickGeminiLabel(labels) };
}

export function accountEligibleForModel(account: Pick<Account, "availableModels" | "tokenState" | "status" | "platform">, model: string) {
  if (account.status && account.status !== "healthy" && account.status !== "probing") {
    return { ok: false as const, reason: "status" };
  }
  if (account.tokenState === "TOKEN_EXHAUSTED") return { ok: false as const, reason: "TOKEN_EXHAUSTED" };
  if (!accountHasLeonardoModel(account, model)) return { ok: false as const, reason: "MODEL_UNAVAILABLE" };
  return { ok: true as const };
}

function leonardoCode(error: string | undefined, fallback: string) {
  const t = (error || "").toUpperCase();
  if (t.includes("TOKEN_EXHAUSTED") || t.includes("OUT OF TOKENS")) return "LEONARDO_TOKEN_EXHAUSTED";
  if (t.includes("QUEUE")) return "LEONARDO_QUEUE_FULL";
  if (t.includes("LOGIN")) return "LEONARDO_LOGIN_REQUIRED";
  if (t.includes("SESSION")) return "LEONARDO_SESSION_EXPIRED";
  if (t.includes("CHALLENGE")) return "LEONARDO_CHALLENGE";
  if (t.includes("MODEL_UNAVAILABLE") || t.includes("MODEL_MISMATCH")) return "LEONARDO_MODEL_UNAVAILABLE";
  if (t.includes("DOM")) return "LEONARDO_DOM_CHANGED";
  if (t.includes("TIMEOUT")) return "LEONARDO_GENERATION_TIMEOUT";
  if (t.includes("RESULT") || t.includes("IMAGE_NOT_FOUND")) return "LEONARDO_RESULT_NOT_FOUND";
  if (t.includes("DOWNLOAD")) return "LEONARDO_DOWNLOAD_FAILED";
  if (t.includes("PROXY")) return "LEONARDO_PROXY_UNAVAILABLE";
  return fallback.startsWith("LEONARDO_") ? fallback : fallback;
}

function guessStateFromError(error?: string): PageState {
  const t = (error || "").toUpperCase();
  if (t.includes("CHALLENGE")) return "CHALLENGE";
  if (t.includes("LOGIN") || t.includes("SESSION")) return "LOGIN_REQUIRED";
  if (t.includes("TOKEN")) return "TOKEN_EXHAUSTED";
  if (t.includes("QUEUE")) return "QUEUE_FULL";
  if (t.includes("MODEL")) return "MODEL_UNAVAILABLE";
  if (t.includes("DOM")) return "DOM_UNKNOWN";
  return "DOM_UNKNOWN";
}
