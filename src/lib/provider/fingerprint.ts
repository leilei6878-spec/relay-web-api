import { createHash } from "node:crypto";
import type { DomFeature, Fingerprint, ProviderId } from "./types";

export function fingerprint(provider: ProviderId, packVersion: string, features: DomFeature[]): Fingerprint {
  const normalized = [...features].sort((a, b) => a.key.localeCompare(b.key));
  const material = normalized.map((f) => `${f.key}:${f.present ? 1 : 0}`).join("|");
  const hash = createHash("sha256").update(`${provider}|${packVersion}|${material}`).digest("hex").slice(0, 16);
  return { provider, packVersion, hash, features: normalized };
}

export function featureDelta(prev: Fingerprint | null | undefined, next: Fingerprint): { changed: boolean; missingCritical: string[] } {
  if (!prev) return { changed: false, missingCritical: [] };
  const prevMap = new Map(prev.features.map((f) => [f.key, f.present]));
  const missingCritical: string[] = [];
  let flipped = 0;
  for (const f of next.features) {
    const was = prevMap.get(f.key);
    if (was === true && f.present === false) {
      flipped += 1;
      const critical = next.provider === "chatgpt"
        ? /composer|input/.test(f.key)
        : /composer|input|send|assistant/.test(f.key);
      if (critical) missingCritical.push(f.key);
    } else if (was !== undefined && was !== f.present) {
      flipped += 1;
    }
  }
  return { changed: flipped >= 2 || prev.hash !== next.hash, missingCritical };
}

export function criticalKeys(provider: ProviderId): string[] {
  if (provider === "gemini" || provider === "leonardo") return ["composer", "send", "image_slot"];
  return ["composer", "send", "assistant", "model_switcher"];
}
