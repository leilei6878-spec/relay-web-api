import { inspectSession } from "../session-probe";
import { assertGeneratedImage } from "./image-guard";
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

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  capabilities(): ProviderCapabilities {
    return {
      chat: false,
      vision: true,
      imageGeneration: true,
      imageEdit: true,
      streaming: false,
      multiTurn: false,
      models: ["gemini-image"],
      maxOutputs: 1,
    };
  },
  selectorPack(version) {
    return packFor("gemini", version);
  },
  validateSession(state: StorageState) {
    return inspectSession(JSON.stringify(state), "gemini");
  },
  detectPageState(signals: PageSignals) {
    return detectPageState(signals, "gemini");
  },
  prepareRequest(input) {
    return prepareChatRequest("gemini", { ...input, kind: input.kind || "image" });
  },
  normalizeError(error, pageState?: PageState) {
    const state = pageState || guessStateFromError(error);
    const mapped = errorForPageState(state, /selector|composer|dom|image/i.test(error || ""));
    return {
      code: mapped.code,
      pageState: state,
      fault: mapped.polluteAccountPool ? "account" : "provider",
      message: error || mapped.message,
      polluteAccountPool: mapped.polluteAccountPool,
    } satisfies NormalizedProviderError;
  },
  verifyModel(requested, actual): ModelVerdict {
    const got = (actual || requested || "gemini-image").toLowerCase();
    if (got.includes("gemini")) return { ok: true, requested: requested || "gemini-image", actual: got, confirmed: true };
    return { ok: false, requested, actual: actual || "", confirmed: false, code: "MODEL_SELECTION_UNCONFIRMED" };
  },
  extractResult(raw): ExtractedResult {
    if (!raw.ok) return { ok: false, error: raw.error || "IMAGE_NOT_FOUND" };
    if (raw.mode === "mock" && process.env.RELAY_ALLOW_MOCK !== "1") {
      return { ok: false, error: "IMAGE_NOT_FOUND: mock forbidden" };
    }
    const gate = assertGeneratedImage(raw.url, { allowSvg: raw.mode === "mock" });
    if (!gate.ok) return gate;
    return { ok: true, url: gate.url };
  },
  fingerprint(features: DomFeature[], packVersion: string) {
    return fingerprint("gemini", packVersion, features);
  },
  healthCheck() {
    return { provider: "gemini" };
  },
};

function guessStateFromError(error?: string): PageState {
  const t = (error || "").toUpperCase();
  if (t.includes("CHALLENGE")) return "CHALLENGE";
  if (t.includes("LOGIN") || t.includes("SESSION")) return "LOGIN_REQUIRED";
  if (t.includes("RATE")) return "RATE_LIMITED";
  if (t.includes("IMAGE")) return "RESULT_READY";
  if (t.includes("DOM")) return "DOM_UNKNOWN";
  return "DOM_UNKNOWN";
}
