import { coordDel, coordGet, coordIncr, coordSet, coordSetNx } from "./coord";

export type CircuitState = "HEALTHY" | "DEGRADED" | "OPEN" | "HALF_OPEN";
export type ProviderId = "chatgpt" | "gemini";

const WINDOW_MS = Number(process.env.RELAY_CIRCUIT_WINDOW_MS || 60_000);
const TRIP = Number(process.env.RELAY_CIRCUIT_TRIP || 3);
const OPEN_MS = Number(process.env.RELAY_CIRCUIT_OPEN_MS || 30_000);
const DEGRADED_AT = 2;

export type CircuitSnapshot = {
  provider: ProviderId;
  state: CircuitState;
  openedAt?: number;
  uniqueFaults?: number;
};

function windowId(now = Date.now()) {
  return Math.floor(now / WINDOW_MS);
}

export async function recordProviderFault(
  provider: ProviderId,
  code: string,
  accountId?: string | null,
) {
  if (code !== "PROVIDER_DOM_CHANGED" && code !== "PROVIDER_UNAVAILABLE") return getCircuit(provider);
  const w = windowId();
  if (accountId) {
    const first = await coordSetNx(`circuit:${provider}:${code}:acct:${accountId}:${w}`, "1", WINDOW_MS);
    if (!first) return getCircuit(provider);
  }
  const n = await coordIncr(`circuit:${provider}:${code}:${w}`, WINDOW_MS);
  if (n >= TRIP) {
    await coordSet(`circuit:${provider}:state`, "OPEN", OPEN_MS);
    await coordSet(`circuit:${provider}:opened`, String(Date.now()), OPEN_MS);
  } else if (n >= DEGRADED_AT) {
    const cur = await coordGet(`circuit:${provider}:state`);
    if (cur !== "OPEN" && cur !== "HALF_OPEN") {
      await coordSet(`circuit:${provider}:state`, "DEGRADED", WINDOW_MS);
    }
  }
  return getCircuit(provider);
}

export async function getCircuit(provider: ProviderId): Promise<CircuitSnapshot> {
  const state = (await coordGet(`circuit:${provider}:state`)) as CircuitState | null;
  const openedAt = Number((await coordGet(`circuit:${provider}:opened`)) || "0") || undefined;
  if (!state) return { provider, state: "HEALTHY" };
  if (state === "OPEN" && openedAt && Date.now() - openedAt > OPEN_MS) {
    await coordSet(`circuit:${provider}:state`, "HALF_OPEN", OPEN_MS);
    return { provider, state: "HALF_OPEN", openedAt };
  }
  return { provider, state, openedAt };
}

export async function canDispatch(provider: ProviderId, isCanary: boolean) {
  const snap = await getCircuit(provider);
  if (snap.state === "OPEN") return isCanary;
  return true;
}

export async function recordCanaryResult(provider: ProviderId, ok: boolean) {
  if (ok) {
    await coordDel(`circuit:${provider}:state`);
    await coordDel(`circuit:${provider}:opened`);
    return getCircuit(provider);
  }
  await coordSet(`circuit:${provider}:state`, "OPEN", OPEN_MS);
  await coordSet(`circuit:${provider}:opened`, String(Date.now()), OPEN_MS);
  return getCircuit(provider);
}

export async function resetCircuit(provider: ProviderId) {
  await coordDel(`circuit:${provider}:state`);
  await coordDel(`circuit:${provider}:opened`);
}
