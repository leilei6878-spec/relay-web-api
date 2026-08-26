import { recordCanaryResult, type ProviderId } from "./circuit";
import type { Account } from "./types";

export const CANARY_STEPS = [
  "dns_network",
  "login_state",
  "input_selector",
  "send_action",
  "response_detection",
  "image_generation_path",
] as const;

export type CanaryStep = (typeof CANARY_STEPS)[number];

export type CanaryProbe = {
  provider: ProviderId;
  steps: CanaryStep[];
  ok: boolean;
  failedStep?: CanaryStep;
  error?: string;
};

export function canaryStepsFor(provider: ProviderId): CanaryStep[] {
  if (provider === "gemini" || provider === "leonardo") return [...CANARY_STEPS];
  return CANARY_STEPS.filter((s) => s !== "image_generation_path");
}

export function isCanaryAccount(account: Account | null | undefined) {
  return Boolean(account && (account as Account & { canary?: boolean }).canary);
}

export function pickCanary(accounts: Account[], provider: ProviderId) {
  return accounts.find((a) => a.platform === provider && isCanaryAccount(a)) ?? null;
}

/**
 * Apply a probe outcome to Provider Health. Never mutates account failCount.
 * Live browser probe against ChatGPT/Gemini is executed by a worker; this
 * function is the control-plane effect.
 */
export async function applyCanaryProbe(probe: CanaryProbe) {
  const snap = await recordCanaryResult(probe.provider, probe.ok);
  return { ...probe, circuit: snap.state };
}
