import type { Account } from "../types";
import { IMAGE_SIZE_PARAMS, aspectFromSize, resolveImageSpec } from "./image-size";

export const LEONARDO_LOGICAL_MODELS = ["leonardo-gpt-image-2", "leonardo-gemini"] as const;
export type LeonardoLogicalModel = (typeof LEONARDO_LOGICAL_MODELS)[number];

export const GPT_IMAGE_LABELS = ["GPT Image 2", "gpt-image-2", "GPT Image"];
export const GEMINI_FAMILY_LABELS = [
  "Nano Banana 2",
  "Nano Banana",
  "gemini-image-2",
  "Gemini Image 2",
  "Gemini 2.5 Flash Image",
  "gemini-2.5-flash-image",
];

export const OFFICIAL_GPT_IMAGE_IDS = [
  "gpt-image-1",
  "gpt-image-1.5",
  "gpt-image-1-mini",
  "gpt-image-2",
  "dall-e-3",
  "dall-e-2",
] as const;
export const OFFICIAL_NANO_IDS = [
  "nano-banana-2",
  "nano-banana",
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-preview",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
  "gemini-2.0-flash-preview-image-generation",
  "gemini-image-2",
] as const;

/** Official OpenAI Images + Google image fields. Unknown keys still 400; these must pass. */
export const IMAGE_OFFICIAL_PARAMS = [
  "prompt",
  "model",
  "image",
  "image_url",
  "images",
  "n",
  "size",
  "quality",
  "width",
  "height",
  "response_format",
  "user",
  "style",
  "background",
  "output_format",
  "output_compression",
  "moderation",
  "partial_images",
  "stream",
  "revision",
  ...IMAGE_SIZE_PARAMS,
] as const;

export const LEONARDO_SIZES = [
  "1024x1024",
  "2048x2048",
  "4096x4096",
  "2880x2880",
  "1536x1024",
  "1024x1536",
  "1792x1024",
  "1024x1792",
  "848x1264",
  "1264x848",
  "1376x768",
  "768x1376",
  "1200x896",
  "896x1200",
  "928x1152",
  "1152x928",
  "1584x672",
  "2752x1536",
  "1536x2752",
  "5504x3072",
  "3072x5504",
  "2528x1696",
  "1696x2528",
  "auto",
] as const;
export const LEONARDO_QUALITY = ["LOW", "MEDIUM", "HIGH"] as const;

/** Aspect chips: public home plus GPT Image 2 / Nano Banana official set. */
export const LEONARDO_ASPECTS = [
  "1:1",
  "3:2",
  "2:3",
  "16:9",
  "4:3",
  "3:4",
  "4:5",
  "5:4",
  "9:16",
  "21:9",
] as const;

export const LEONARDO_MAX_REFS = 6;
export const LEONARDO_MAX_N = 8;
export const LEONARDO_BACKEND_DEFAULT = "web_account" as const;
export const LEONARDO_CAPABILITY_TTL_MS = 30 * 60_000;

export function isGptImageModel(model: string) {
  const m = (model || "").toLowerCase();
  return m.includes("gpt-image") || m.startsWith("dall-e") || m === "leonardo-gpt-image-2";
}

export function isNanoBananaModel(model: string) {
  const m = (model || "").toLowerCase();
  if (m === "gemini-image") return false;
  return (
    m.includes("nano-banana") ||
    m.includes("flash-image") ||
    m.includes("pro-image") ||
    m.includes("lite-image") ||
    m.includes("gemini-image-") ||
    m.startsWith("imagen") ||
    m === "leonardo-gemini"
  );
}

export function isLeonardoModel(model: string) {
  const m = (model || "").toLowerCase();
  return m.startsWith("leonardo-") || isGptImageModel(m) || isNanoBananaModel(m);
}

export function mapLogicalModel(model: string): {
  logical: LeonardoLogicalModel;
  webLabels: string[];
  webId: string;
} {
  if (isGptImageModel(model)) {
    return { logical: "leonardo-gpt-image-2", webLabels: GPT_IMAGE_LABELS, webId: "gpt-image-2" };
  }
  return { logical: "leonardo-gemini", webLabels: GEMINI_FAMILY_LABELS, webId: process.env.LEONARDO_GEMINI_MODEL || "auto" };
}

export function pickGeminiLabel(available: string[]) {
  const pref = (process.env.LEONARDO_GEMINI_MODEL || "auto").toLowerCase();
  const lower = available.map((s) => s.toLowerCase());
  if (pref !== "auto") {
    const hit = available.find((s) => s.toLowerCase().includes(pref.replace(/_/g, " ")));
    if (hit) return hit;
    const byId = available.find((_, i) => lower[i]?.includes(pref));
    if (byId) return byId;
  }
  for (const lab of GEMINI_FAMILY_LABELS) {
    const hit = available.find((s) => s.toLowerCase().includes(lab.toLowerCase()));
    if (hit) return hit;
  }
  return available.find((s) => /nano|gemini|banana/i.test(s)) || "";
}

export function labelsForLogical(logical: LeonardoLogicalModel) {
  return logical === "leonardo-gpt-image-2" ? GPT_IMAGE_LABELS : GEMINI_FAMILY_LABELS;
}

export function accountHasLeonardoModel(
  account: Pick<Account, "availableModels" | "availableModelsObservedAt" | "platform">,
  model: string,
  now = Date.now(),
) {
  if (account.platform && account.platform !== "leonardo") return true;
  const listed = account.availableModels;
  if (!listed || listed.length === 0) return true;
  const mapped = mapLogicalModel(model);
  const needles = [mapped.logical, mapped.webId, ...mapped.webLabels].map((s) => s.toLowerCase());
  const matched = listed.some((item) => {
    const x = item.toLowerCase();
    return needles.some((n) => x.includes(n) || n.includes(x));
  });
  if (matched) return true;

  // Older workers only captured the currently selected model and stored that
  // partial list forever. Treat missing or stale observations as unknown so a
  // real request can re-probe the model drawer. A fresh negative observation
  // remains authoritative and prevents repeatedly consuming an unsupported account.
  const observedAt = Date.parse(account.availableModelsObservedAt || "");
  if (!Number.isFinite(observedAt) || now - observedAt >= LEONARDO_CAPABILITY_TTL_MS) return true;
  return false;
}

export function sizeToAspect(size: string): (typeof LEONARDO_ASPECTS)[number] {
  const aspect = aspectFromSize(size);
  if ((LEONARDO_ASPECTS as readonly string[]).includes(aspect)) return aspect as (typeof LEONARDO_ASPECTS)[number];
  return "1:1";
}

export function parseSizeBox(size?: string, width?: number, height?: number) {
  const resolved = resolveImageSpec({ size, width, height });
  if (!resolved.ok) {
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      return { w: Math.round(width), h: Math.round(height), size: `${Math.round(width)}x${Math.round(height)}` };
    }
    return { w: 1024, h: 1024, size: "1024x1024" };
  }
  return { w: resolved.spec.width, h: resolved.spec.height, size: resolved.spec.size };
}

export function sizeTier(w: number, h: number, gpt: boolean): { tier: "Small" | "Medium" | "Large"; px: number } {
  const spec = resolveImageSpec({
    model: gpt ? "gpt-image-2" : "nano-banana",
    width: w,
    height: h,
  });
  if (spec.ok) {
    const px = Math.max(spec.spec.width, spec.spec.height);
    return { tier: spec.spec.tier, px };
  }
  const m = Math.max(w, h);
  if (gpt) {
    if (m >= 2500) return { tier: "Large", px: 2880 };
    if (m >= 1536) return { tier: "Medium", px: 2048 };
    return { tier: "Small", px: 1024 };
  }
  if (m >= 3072) return { tier: "Large", px: 4096 };
  if (m >= 1536) return { tier: "Medium", px: 2048 };
  return { tier: "Small", px: 1024 };
}

export function normalizeQuality(raw?: string) {
  const q = (raw || "medium").toString().trim().toLowerCase();
  if (q === "high" || q === "hd" || q === "high-quality") return "HIGH";
  if (q === "low") return "LOW";
  if (q === "auto" || q === "standard") return "MEDIUM";
  return "MEDIUM";
}

export function defaultResponseFormat(model: string, requested?: string): "url" | "b64_json" {
  const r = (requested || "").toLowerCase();
  if (r === "b64_json" || r === "b64" || r === "base64") return "b64_json";
  if (r === "url") return "url";
  const m = (model || "").toLowerCase();
  if ((m.startsWith("gpt-image") || m.startsWith("dall-e")) && !m.startsWith("leonardo-")) return "b64_json";
  return "url";
}

export function validateLeonardoParams(input: {
  n?: number;
  size?: string;
  quality?: string;
  images?: string[];
  logical: LeonardoLogicalModel;
  width?: number;
  height?: number;
  aspectRatio?: string;
  imageSize?: string;
  model?: string;
}) {
  const n = input.n ?? 1;
  if (!Number.isFinite(n) || n < 1 || n > LEONARDO_MAX_N) {
    return { ok: false as const, error: "unsupported parameter: n must be 1-8" };
  }
  const resolved = resolveImageSpec({
    model: input.model || input.logical,
    size: input.size,
    width: input.width,
    height: input.height,
    aspectRatio: input.aspectRatio,
    imageSize: input.imageSize,
  });
  if (!resolved.ok) return { ok: false as const, error: resolved.error };
  if (input.quality) {
    const q = input.quality.toString().trim().toLowerCase();
    const ok = ["low", "medium", "high", "hd", "standard", "auto", "high-quality"].includes(q);
    if (!ok && !LEONARDO_QUALITY.includes(input.quality.toUpperCase() as (typeof LEONARDO_QUALITY)[number])) {
      return { ok: false as const, error: `unsupported parameter: quality ${input.quality}` };
    }
  }
  if ((input.images?.length || 0) > LEONARDO_MAX_REFS) {
    return { ok: false as const, error: `unsupported parameter: images max ${LEONARDO_MAX_REFS}` };
  }
  return {
    ok: true as const,
    n,
    size: resolved.spec.size,
    quality: normalizeQuality(input.quality),
    aspect: resolved.spec.aspect,
    width: resolved.spec.width,
    height: resolved.spec.height,
    tier: resolved.spec.tier,
    imageSize: resolved.spec.imageSize,
  };
}

export function leonardoBackendMode(): "web_account" | "official_api" {
  const raw = (process.env.LEONARDO_BACKEND_MODE || LEONARDO_BACKEND_DEFAULT).toLowerCase();
  return raw === "official_api" ? "official_api" : "web_account";
}
