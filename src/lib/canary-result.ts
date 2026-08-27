import { canaryStepsFor } from "./canary.ts";
import type { ProviderId } from "./circuit.ts";
import { fallbackPack } from "./provider/selectors.ts";
import { applyWorkerCanary } from "./provider/canary-run.ts";
import type { DomFeature } from "./provider/types.ts";
import {
  candidateSelectorPack,
  recordSelectorCanary,
  setCandidateSelectorPack,
} from "./selector-promotion.ts";

function featuresFromWorker(value: unknown): DomFeature[] {
  if (!value || typeof value !== "object") return [];
  const rows = (value as { features?: unknown }).features;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (typeof row === "string") {
      const split = row.lastIndexOf(":");
      if (split > 0) {
        return [{ key: row.slice(0, split), present: row.slice(split + 1) === "1" }];
      }
      return [];
    }
    if (row && typeof row === "object" && typeof (row as { key?: unknown }).key === "string") {
      return [{
        key: (row as { key: string }).key,
        present: Boolean((row as { present?: unknown }).present),
      }];
    }
    return [];
  });
}

export async function processStructuralCanaryResult(input: {
  provider: ProviderId;
  selectorPackVersion: string;
  ok: boolean;
  error?: string;
  errorCode?: string;
  fingerprint?: unknown;
}) {
  const features = featuresFromWorker(input.fingerprint);
  const probe = await applyWorkerCanary(
    input.provider,
    {
      provider: input.provider,
      steps: canaryStepsFor(input.provider),
      ok: input.ok,
      failedStep: input.ok ? undefined : "response_detection",
      error: input.error,
    },
    features,
  );

  const candidate = await candidateSelectorPack(input.provider);
  let promotion:
    | Awaited<ReturnType<typeof recordSelectorCanary>>
    | { ignored: true; promoted: false; rolledBack: false; passes: number } = {
    ignored: true,
    promoted: false,
    rolledBack: false,
    passes: 0,
  };
  if (candidate === input.selectorPackVersion) {
    promotion = await recordSelectorCanary(input.provider, input.selectorPackVersion, input.ok);
  } else if (
    !input.ok &&
    (input.errorCode === "PROVIDER_DOM_CHANGED" || input.errorCode === "LEONARDO_DOM_CHANGED")
  ) {
    const fallback = fallbackPack(input.provider, input.selectorPackVersion);
    if (fallback) await setCandidateSelectorPack(input.provider, fallback.version);
  }
  return { probe, promotion };
}

export { featuresFromWorker };
