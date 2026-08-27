import type { ProviderId } from "./circuit";
import { CURRENT_PACK, packFor } from "./provider/selectors";

const PROMOTE_N = () => Math.max(3, Number(process.env.RELAY_SELECTOR_PROMOTE_N || 3) || 3);

type Promo = {
  active: Record<ProviderId, string>;
  candidate: Partial<Record<ProviderId, string>>;
  passes: Partial<Record<ProviderId, number>>;
};

const DEFAULT_PACK: Record<ProviderId, string> = {
  chatgpt: "chatgpt-v1",
  gemini: "gemini-v1",
  leonardo: "leonardo-image-v1",
};

const state: Promo = {
  active: { ...DEFAULT_PACK },
  candidate: {},
  passes: {},
};

export function resetSelectorPromotionForTests() {
  Object.assign(CURRENT_PACK, DEFAULT_PACK);
  state.active = { ...DEFAULT_PACK };
  state.candidate = {};
  state.passes = {};
}

export function activeSelectorPack(provider: ProviderId) {
  return state.active[provider] || CURRENT_PACK[provider];
}

export function candidateSelectorPack(provider: ProviderId) {
  return state.candidate[provider] || null;
}

export function setCandidateSelectorPack(provider: ProviderId, version: string) {
  packFor(provider, version);
  state.candidate[provider] = version;
  state.passes[provider] = 0;
  return { provider, candidate: version };
}

export function recordSelectorCanary(provider: ProviderId, packVersion: string, ok: boolean) {
  if (state.candidate[provider] !== packVersion) {
    return { ignored: true, promoted: false, rolledBack: false, passes: state.passes[provider] || 0 };
  }
  if (!ok) {
    delete state.candidate[provider];
    state.passes[provider] = 0;
    return { ignored: false, promoted: false, rolledBack: true, passes: 0 };
  }
  const n = (state.passes[provider] || 0) + 1;
  state.passes[provider] = n;
  if (n >= PROMOTE_N()) {
    state.active[provider] = packVersion;
    CURRENT_PACK[provider] = packVersion;
    delete state.candidate[provider];
    state.passes[provider] = 0;
    return { ignored: false, promoted: true, rolledBack: false, passes: n };
  }
  return { ignored: false, promoted: false, rolledBack: false, passes: n };
}
