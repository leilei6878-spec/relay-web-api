function userContent(prompt: string, images: string[] = []) {
  if (!images.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

const SYSTEM = "直接按用户的问题和图片作答，不要自称网关、演示或预览模型。";

function chatBody(prompt: string, images: string[], stream: boolean) {
  return {
    model: "grok-4.20-0309-non-reasoning",
    max_tokens: 1600,
    stream,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userContent(prompt, images) },
    ],
  };
}

export async function fallbackChat(prompt: string, timeoutMs = 60_000, images: string[] = []) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false as const, error: "预览网关未配置模型密钥" };
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(chatBody(prompt, images, false)),
  });
  if (!res.ok) {
    if (images.length) return fallbackChat(`${prompt}\n（附带 ${images.length} 张图片，未能解析。）`, timeoutMs);
    return { ok: false as const, error: `网关上游错误 ${res.status}` };
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? "";
  if (!text) return { ok: false as const, error: "上游空回复" };
  return { ok: true as const, text };
}

export async function openPreviewChatStream(prompt: string, images: string[] = []) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false as const, error: "预览网关未配置模型密钥" };
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(chatBody(prompt, images, true)),
  });
  if (!res.ok || !res.body) {
    if (images.length) return openPreviewChatStream(`${prompt}\n（附带 ${images.length} 张图片，未能解析。）`, []);
    return { ok: false as const, error: `网关上游错误 ${res.status}` };
  }
  return { ok: true as const, body: res.body };
}

export async function fallbackImage(prompt: string, timeoutMs = 60_000, images: string[] = []) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false as const, error: "预览网关未配置模型密钥" };
  let finalPrompt = prompt;
  if (images.length) {
    const desc = await fallbackChat(`用一两句话描述参考图，并说明如何按用户要求改图。用户要求：${prompt}`, timeoutMs, images);
    if (desc.ok) finalPrompt = `${prompt}。参考图内容：${desc.text}`;
  }
  const res = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model: "grok-imagine-image", prompt: finalPrompt }),
  });
  if (!res.ok) return { ok: false as const, error: `出图上游错误 ${res.status}` };
  const body = (await res.json()) as { data?: { url?: string }[] };
  const url = body.data?.[0]?.url || "";
  if (!url) return { ok: false as const, error: "未返回图片" };
  return { ok: true as const, url };
}
