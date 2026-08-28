import { applyCanaryProbe, canaryStepsFor, pickCanary, type CanaryProbe } from "../canary";
import { getCircuit, type ProviderId } from "../circuit";
import { coordGet, coordSet } from "../coord";
import { readControlPlane } from "../control-plane";
import { enqueueChat, enqueueImage } from "../job-queue";
import { featureDelta, fingerprint } from "./fingerprint";
import { getAdapter } from "./index";
import type { DomFeature } from "./types";
import { activeSelectorPack, selectorPackForCanary } from "../selector-promotion";
import { accountHasLeonardoModel } from "./leonardo-models";
import type { Account } from "../types";

export function canaryModelFor(
  provider: ProviderId,
  account: Pick<Account, "platform" | "availableModels">,
  models: string[],
) {
  if (provider !== "leonardo") return models[0] || "";
  return models.find((model) => accountHasLeonardoModel(account, model)) || models[0] || "";
}

export async function rememberFingerprint(provider: ProviderId, features: DomFeature[], packVersion: string) {
  const fp = fingerprint(provider, packVersion, features);
  const prevRaw = await coordGet(`fingerprint:${provider}`);
  let prev = null;
  try {
    prev = prevRaw ? (JSON.parse(prevRaw) as ReturnType<typeof fingerprint>) : null;
  } catch {
    prev = null;
  }
  await coordSet(`fingerprint:${provider}`, JSON.stringify(fp), 86_400_000);
  const delta = featureDelta(prev, fp);
  return { fp, delta, previous: prev };
}

/**
 * Control-plane canary. Live DOM probe is executed by a worker job with kind=canary.
 * Never increments account failCount (enqueue uses canary account + circuit recordCanaryResult).
 */
export async function enqueueProviderCanary(provider: ProviderId, kind: "structural" | "paid" = "structural") {
  if (kind === "paid" && provider === "chatgpt") {
    return { ok: false as const, error: "paid image canary is not applicable to chatgpt" };
  }
  const plane = await readControlPlane();
  const account = pickCanary(plane.accounts, provider);
  if (!account) {
    const snap = await getCircuit(provider);
    return { ok: false as const, error: "no canary account", circuit: snap.state };
  }
  const adapter = getAdapter(provider);
  const model = canaryModelFor(provider, account, adapter.capabilities().models);
  const selectorPackVersion =
    kind === "structural"
      ? await selectorPackForCanary(provider)
      : await activeSelectorPack(provider);
  const prepared = adapter.prepareRequest({
    prompt:
      kind === "paid"
        ? "A plain cobalt blue square centered on a white background"
        : "Reply with the single word: pong",
    model,
    kind: kind === "paid" ? "image" : "canary",
  });
  const excludeAccountIds = plane.accounts.filter((item) => item.id !== account.id).map((item) => item.id);
  const timeoutMs = kind === "paid" ? (provider === "leonardo" ? 180_000 : 90_000) : 45_000;
  const queued =
    provider === "gemini" || provider === "leonardo"
      ? await enqueueImage(prepared.webPrompt, prepared.model, timeoutMs, [], {
          kind: kind === "paid" ? "image" : "canary",
          selectorPackVersion,
          excludeAccountIds,
          n: 1,
          size: "1024x1024",
          aspect: "1:1",
          tier: "Small",
        })
      : await enqueueChat(prepared.webPrompt, prepared.model, timeoutMs, [], {
          kind: "canary",
          selectorPackVersion,
          excludeAccountIds,
        });
  return queued;
}

export async function applyWorkerCanary(provider: ProviderId, probe: CanaryProbe, features?: DomFeature[]) {
  if (features?.length) {
    const pack = getAdapter(provider).selectorPack().version;
    const { delta } = await rememberFingerprint(provider, features, pack);
    if (delta.missingCritical.length) {
      return applyCanaryProbe({
        provider,
        steps: canaryStepsFor(provider),
        ok: false,
        failedStep: "input_selector",
        error: `fingerprint missing ${delta.missingCritical.join(",")}`,
      });
    }
    if (delta.changed && probe.ok) {
      return applyCanaryProbe({ ...probe, ok: true });
    }
  }
  return applyCanaryProbe(probe);
}
