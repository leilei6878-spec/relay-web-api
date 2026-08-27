import type { Platform } from "./types.ts";
import { withLock } from "./coord.ts";

export type QueueCounts = {
  global: number;
  provider: number;
  capability: number;
  key: number;
};

export type QueueScope = keyof QueueCounts;

function positive(raw: string | undefined, fallback: number) {
  const value = Number(raw || fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function queueCapability(platform: Platform) {
  return platform === "chatgpt" ? "chat" : "image";
}

export function queueCaps(env: NodeJS.ProcessEnv = process.env) {
  return {
    global: positive(env.RELAY_QUEUE_CAP, 200),
    provider: positive(env.RELAY_PROVIDER_QUEUE_CAP, 100),
    chat: positive(env.RELAY_CHAT_QUEUE_CAP, 100),
    image: positive(env.RELAY_IMAGE_QUEUE_CAP, 50),
    key: positive(env.RELAY_KEY_QUEUE_CAP, 20),
  };
}

export function queueAdmissionError(
  counts: QueueCounts,
  platform: Platform,
  hasKey: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  const caps = queueCaps(env);
  const checks: [QueueScope, number][] = [
    ["global", caps.global],
    ["provider", caps.provider],
    ["capability", queueCapability(platform) === "chat" ? caps.chat : caps.image],
  ];
  if (hasKey) checks.push(["key", caps.key]);
  for (const [scope, cap] of checks) {
    if (counts[scope] >= cap) {
      return `QUEUE_FULL: 429 scope=${scope} depth=${counts[scope]} cap=${cap} retry_after=5`;
    }
  }
  return null;
}

export async function withQueueAdmission<T>(input: {
  platform: Platform;
  hasKey: boolean;
  bypass?: boolean;
  readCounts: () => Promise<QueueCounts>;
  insert: () => Promise<T>;
  env?: NodeJS.ProcessEnv;
}) {
  if (input.bypass) return { error: null as string | null, inserted: await input.insert() };
  return withLock("queue-admission:postgres", 5_000, async () => {
    const counts = await input.readCounts();
    const error = queueAdmissionError(counts, input.platform, input.hasKey, input.env);
    if (error) return { error, inserted: null as T | null };
    return { error: null as string | null, inserted: await input.insert() };
  });
}
