import { collectSizeInput, type SizeInput } from "./image-size";

export type GeminiImageRequest = {
  model: string;
  prompt: string;
  images: string[];
  sizeInput: SizeInput;
  n: number;
  responseFormat: "b64_json";
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function inlineToDataUrl(part: Record<string, unknown>): string {
  const inline = asRecord(part.inlineData || part.inline_data);
  const data = typeof inline.data === "string" ? inline.data : "";
  if (!data) return "";
  const mime =
    (typeof inline.mimeType === "string" && inline.mimeType) ||
    (typeof inline.mime_type === "string" && inline.mime_type) ||
    "image/png";
  return `data:${mime};base64,${data}`;
}

function collectParts(body: Record<string, unknown>): { text: string[]; images: string[] } {
  const texts: string[] = [];
  const images: string[] = [];
  const contents = Array.isArray(body.contents) ? body.contents : [];
  for (const c of contents) {
    const rec = asRecord(c);
    const parts = Array.isArray(rec.parts) ? rec.parts : [];
    for (const p of parts) {
      const part = asRecord(p);
      if (typeof part.text === "string" && part.text.trim()) texts.push(part.text.trim());
      const dataUrl = inlineToDataUrl(part);
      if (dataUrl) images.push(dataUrl);
      const file = asRecord(part.fileData || part.file_data);
      const uri = typeof file.fileUri === "string" ? file.fileUri : typeof file.file_uri === "string" ? file.file_uri : "";
      if (uri.startsWith("http") || uri.startsWith("data:image")) images.push(uri);
    }
  }
  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    const rec = asRecord(item);
    if (rec.type === "text" && typeof rec.text === "string" && rec.text.trim()) texts.push(rec.text.trim());
    if (rec.type === "image") {
      if (typeof rec.data === "string" && rec.data) {
        const mime = typeof rec.mime_type === "string" ? rec.mime_type : "image/png";
        images.push(`data:${mime};base64,${rec.data}`);
      }
    }
  }
  if (!texts.length && typeof body.prompt === "string") texts.push(body.prompt.trim());
  return { text: texts, images };
}

export function parseModelAction(splat: string) {
  const raw = decodeURIComponent(splat || "").trim();
  const cut = raw.lastIndexOf(":");
  if (cut <= 0) return { model: raw || "gemini-2.5-flash-image", action: "generateContent" };
  return { model: raw.slice(0, cut) || "gemini-2.5-flash-image", action: raw.slice(cut + 1) || "generateContent" };
}

export function parseGeminiGenerateContent(
  body: Record<string, unknown>,
  modelFromPath?: string,
): GeminiImageRequest {
  const model =
    (typeof body.model === "string" && body.model.trim()) ||
    modelFromPath ||
    "gemini-2.5-flash-image";
  const { text, images } = collectParts(body);
  const gc = asRecord(body.generationConfig || body.generation_config);
  const n = asRecord(gc).candidateCount
    ? Number(gc.candidateCount)
    : typeof body.n === "number"
      ? body.n
      : 1;
  return {
    model,
    prompt: text.join("\n").trim(),
    images,
    sizeInput: collectSizeInput(body, model),
    n: Number.isFinite(n) && n > 0 ? Math.min(8, Math.round(n)) : 1,
    responseFormat: "b64_json",
  };
}

export function geminiGenerateContentResponse(input: {
  b64: string;
  mime?: string;
  model: string;
  text?: string;
}) {
  const mime = input.mime || "image/png";
  const parts: Record<string, unknown>[] = [];
  if (input.text) parts.push({ text: input.text });
  parts.push({ inlineData: { mimeType: mime, data: input.b64 } });
  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    },
    modelVersion: input.model,
  };
}

export function mimeFromDataUrl(url: string) {
  const m = url.match(/^data:([^;]+);base64,/);
  return m?.[1] || "image/png";
}
