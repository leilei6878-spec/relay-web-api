import type { ProviderId } from "./circuit";
import { coordDel, coordGet, coordSet, withLock } from "./coord";
import { CURRENT_PACK, packFor } from "./provider/selectors";

const PROVIDERS: ProviderId[] = ["chatgpt", "gemini", "leonardo"];
const PROMOTE_N = () => Math.max(3, Number(process.env.RELAY_SELECTOR_PROMOTE_N || 3) || 3);

type ProviderPromo = {
  active: string;
  candidate?: string;
  passes: number;
};

const DEFAULT_PACK: Record<ProviderId, string> = {
  chatgpt: "chatgpt-v1",
  gemini: "gemini-v1",
  leonardo: "leonardo-image-v1",
};

function key(provider: ProviderId) {
  return `selector-promotion:${provider}`;
}

async function read(provider: ProviderId): Promise<ProviderPromo> {
  const raw = await coordGet(key(provider));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ProviderPromo;
      if (parsed.active) return { ...parsed, passes: Number(parsed.passes || 0) };
    } catch {
      // Fall through to the repository default.
    }
  }
  return { active: DEFAULT_PACK[provider], passes: 0 };
}

async function write(provider: ProviderId, state: ProviderPromo) {
  await coordSet(key(provider), JSON.stringify(state));
}

export async function resetSelectorPromotionForTests() {
  Object.assign(CURRENT_PACK, DEFAULT_PACK);
  await Promise.all(PROVIDERS.map((provider) => coordDel(key(provider))));
}

export async function activeSelectorPack(provider: ProviderId) {
  return (await read(provider)).active;
}

export async function candidateSelectorPack(provider: ProviderId) {
  return (await read(provider)).candidate || null;
}

export async function selectorPackForCanary(provider: ProviderId) {
  const state = await read(provider);
  return state.candidate || state.active;
}

export async function setCandidateSelectorPack(provider: ProviderId, version: string) {
  packFor(provider, version);
  return withLock(`selector-promotion-lock:${provider}`, 2_000, async () => {
    const state = await read(provider);
    if (state.active === version) return { provider, candidate: null, alreadyActive: true };
    await write(provider, { ...state, candidate: version, passes: 0 });
    return { provider, candidate: version, alreadyActive: false };
  });
}

export async function recordSelectorCanary(provider: ProviderId, packVersion: string, ok: boolean) {
  return withLock(`selector-promotion-lock:${provider}`, 2_000, async () => {
    const state = await read(provider);
    if (state.candidate !== packVersion) {
      return { ignored: true, promoted: false, rolledBack: false, passes: state.passes };
    }
    if (!ok) {
      await write(provider, { active: state.active, passes: 0 });
      return { ignored: false, promoted: false, rolledBack: true, passes: 0 };
    }
    const passes = state.passes + 1;
    if (passes >= PROMOTE_N()) {
      await write(provider, { active: packVersion, passes: 0 });
      return { ignored: false, promoted: true, rolledBack: false, passes };
    }
    await write(provider, { ...state, passes });
    return { ignored: false, promoted: false, rolledBack: false, passes };
  });
}
