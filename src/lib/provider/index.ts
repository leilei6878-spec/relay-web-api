import { chatgptAdapter } from "./chatgpt";
import { geminiAdapter } from "./gemini";
import { leonardoAdapter } from "./leonardo";
import type { ProviderAdapter, ProviderId } from "./types";

export { chatgptAdapter } from "./chatgpt";
export { geminiAdapter } from "./gemini";
export { leonardoAdapter } from "./leonardo";
export { detectPageState, errorForPageState } from "./page-state";
export { prepareChatRequest, toWebPrompt, turnsFromMessages } from "./prompt-map";
export { packFor, selectorCandidates, CURRENT_PACK } from "./selectors";
export { applySessionUpdate, canWriteSession, sessionExpired } from "./session-cas";
export { assertGeneratedImage, assertGeneratedBytes, isUiOrOldSrc } from "./image-guard";
export { validateImageResults, validateJobImageUrls } from "./image-result-validator";
export { fingerprint, featureDelta } from "./fingerprint";
export type { ProviderAdapter, ProviderId, PageState, ChatTurn, PreparedRequest } from "./types";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  chatgpt: chatgptAdapter,
  gemini: geminiAdapter,
  leonardo: leonardoAdapter,
};

export function getAdapter(id: ProviderId): ProviderAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error(`unknown provider ${id}`);
  return adapter;
}
