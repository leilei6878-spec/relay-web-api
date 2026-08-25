import { createServerFn } from "@tanstack/react-start";
import type { ChatgptWebInput, ProbeProxyInput } from "./gateway-types";
import type { Account, GatewaySettings, Proxy } from "./types";

type ChatInput = { prompt: string; modelLabel: string; timeoutMs?: number };

export const runGatewayChat = createServerFn({ method: "POST" })
  .validator((input: ChatInput) => input)
  .handler(async ({ data }) => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return { ok: false as const, error: "当前环境未配置模型网关密钥" };
    }
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(data.timeoutMs ?? 90_000),
      body: JSON.stringify({
        model: "grok-4.5",
        max_tokens: 700,
        messages: [
          {
            role: "system",
            content: "You are the Relay gateway model. Reply concisely in the user's language.",
          },
          { role: "user", content: data.prompt },
        ],
      }),
    });
    if (!res.ok) {
      return { ok: false as const, error: `网关上游错误 ${res.status}` };
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    return { ok: true as const, text };
  });

export const runGatewayImage = createServerFn({ method: "POST" })
  .validator((input: { prompt: string; timeoutMs?: number }) => input)
  .handler(async ({ data }) => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return { ok: false as const, error: "当前环境未配置模型网关密钥" };
    }
    const res = await fetch("https://api.x.ai/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(data.timeoutMs ?? 90_000),
      body: JSON.stringify({
        model: "grok-2-image",
        prompt: data.prompt,
      }),
    });
    if (!res.ok) {
      return { ok: false as const, error: `出图上游错误 ${res.status}` };
    }
    const body = (await res.json()) as { data?: { url?: string }[] };
    const url = body.data?.[0]?.url ?? "";
    if (!url) return { ok: false as const, error: "未返回图片" };
    return { ok: true as const, url };
  });

type SaveSessionInput = { accountId: string; json: string };

export const saveSessionFile = createServerFn({ method: "POST" })
  .validator((input: SaveSessionInput) => input)
  .handler(async ({ data }) => {
    const { writeSessionFile } = await import("./chatgpt-runner");
    return writeSessionFile(data.accountId, data.json);
  });

export const readSessionFile = createServerFn({ method: "POST" })
  .validator((input: { accountId: string }) => input)
  .handler(async ({ data }) => {
    const { readSessionJson } = await import("./chatgpt-runner");
    return readSessionJson(data.accountId);
  });

export const runChatgptWeb = createServerFn({ method: "POST" })
  .validator((input: ChatgptWebInput) => input)
  .handler(async ({ data }) => {
    const { runChatgptJob } = await import("./chatgpt-runner");
    const result = await runChatgptJob(data);
    if (!result.ok) return { ok: false as const, error: result.error };
    return { ok: true as const, text: result.text };
  });

export const probeProxy = createServerFn({ method: "POST" })
  .validator((input: ProbeProxyInput) => input)
  .handler(async ({ data }) => {
    const { probeProxyJob } = await import("./chatgpt-runner");
    return probeProxyJob(data);
  });

export const saveControlPlane = createServerFn({ method: "POST" })
  .validator((input: { accounts: Account[]; proxies: Proxy[]; settings: GatewaySettings }) => input)
  .handler(async ({ data }) => {
    const { writeControlPlane } = await import("./control-plane");
    return writeControlPlane(data);
  });

export const getApiKey = createServerFn({ method: "GET" }).handler(async () => {
  const { ensureApiKey } = await import("./control-plane");
  return { apiKey: await ensureApiKey() };
});

export const listGatewayJobs = createServerFn({ method: "GET" }).handler(async () => {
  const { listJobs } = await import("./job-queue");
  return listJobs();
});
