/**
 * Official size tables for GPT Image (OpenAI Images API) and
 * Gemini / Nano Banana (Google imageConfig.aspectRatio + imageSize).
 *
 * Native 1K pixel boxes match Google Gemini 3.1 Flash Image / Leonardo GPT Image 2.
 * Leonardo Image Dimensions: aspect chips then Small / Medium / Large.
 */

export const IMAGE_ASPECTS = [
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "4:5",
  "5:4",
  "21:9",
] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

export type ImageTier = "Small" | "Medium" | "Large";
export type ImageK = "1K" | "2K" | "4K";
export type ImageFamily = "gpt" | "nano" | "gemini";

/** Official 1K boxes (Nano Banana 2 / Gemini 3.1 Flash Image / Leonardo GPT Image 2). */
export const NATIVE_1K: Record<ImageAspect, readonly [number, number]> = {
  "1:1": [1024, 1024],
  "3:2": [1264, 848],
  "2:3": [848, 1264],
  "4:3": [1200, 896],
  "3:4": [896, 1200],
  "16:9": [1376, 768],
  "9:16": [768, 1376],
  "4:5": [928, 1152],
  "5:4": [1152, 928],
  "21:9": [1584, 672],
};

/** GPT Image 2 Large targets stay inside Leonardo's 8,294,400-pixel envelope. */
export const GPT_LARGE: Record<ImageAspect, readonly [number, number]> = {
  "1:1": [2880, 2880],
  "3:2": [3504, 2336],
  "2:3": [2336, 3504],
  "4:3": [3264, 2448],
  "3:4": [2448, 3264],
  "16:9": [3584, 2016],
  "9:16": [2016, 3584],
  "4:5": [2560, 3200],
  "5:4": [3200, 2560],
  "21:9": [3584, 1536],
};

/** Leonardo GPT Image 2 web UI Medium targets observed from its size state. */
export const GPT_MEDIUM: Record<ImageAspect, readonly [number, number]> = {
  "1:1": [2048, 2048],
  "3:2": [2048, 1376],
  "2:3": [1376, 2048],
  "4:3": [2048, 1536],
  "3:4": [1536, 2048],
  "16:9": [2048, 1136],
  "9:16": [1136, 2048],
  "4:5": [1648, 2048],
  "5:4": [2048, 1648],
  "21:9": [2048, 864],
};

/** Leonardo Custom panel named presets (fig. 3). */
export const ASPECT_PRESETS: { id: ImageAspect; label: string; hint: string }[] = [
  { id: "1:1", label: "1:1 方图", hint: "Square" },
  { id: "16:9", label: "16:9 横图", hint: "Facebook / Desktop" },
  { id: "9:16", label: "9:16 竖图", hint: "TikTok / Mobile" },
  { id: "4:3", label: "4:3 横图", hint: "Twitter" },
  { id: "4:5", label: "4:5 竖图", hint: "Instagram" },
  { id: "2:3", label: "2:3 竖图", hint: "" },
  { id: "3:2", label: "3:2 横图", hint: "" },
  { id: "21:9", label: "21:9 超宽", hint: "Ultrawide" },
  { id: "3:4", label: "3:4 竖图", hint: "" },
  { id: "5:4", label: "5:4 横图", hint: "" },
];

/** OpenAI Images API `size` values for gpt-image-*. */
export const OPENAI_GPT_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "1152x2048",
  "3840x2160",
  "2160x3840",
  "auto",
] as const;

export const IMAGE_SIZE_PARAMS = [
  "aspect_ratio",
  "aspectRatio",
  "image_size",
  "imageSize",
  "image_config",
  "imageConfig",
] as const;

export type ImageSpec = {
  size: string;
  width: number;
  height: number;
  aspect: ImageAspect;
  tier: ImageTier;
  imageSize: ImageK;
  family: ImageFamily;
};

export type SizeInput = {
  model?: string;
  size?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  imageSize?: string;
};

export type ResolutionOption = {
  k: ImageK;
  tier: ImageTier;
  w: number;
  h: number;
  size: string;
  label: string;
};

export function imageFamily(model?: string): ImageFamily {
  const m = (model || "").toLowerCase();
  if (m.includes("gpt-image") || m.startsWith("dall-e") || m === "leonardo-gpt-image-2") return "gpt";
  if (m === "gemini-image" || (m.startsWith("gemini") && !m.includes("image") && !m.includes("banana") && !m.includes("imagen"))) {
    return "gemini";
  }
  if (
    m.includes("nano-banana") ||
    m.includes("flash-image") ||
    m.includes("pro-image") ||
    m.includes("lite-image") ||
    m.includes("gemini-image") ||
    m.startsWith("imagen") ||
    m === "leonardo-gemini"
  ) {
    return "nano";
  }
  if (m.includes("gemini")) return "gemini";
  return "nano";
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

export function collectSizeInput(body: Record<string, unknown>, model?: string): SizeInput {
  const gc = (body.generationConfig || body.generation_config || {}) as Record<string, unknown>;
  const ic = (body.imageConfig ||
    body.image_config ||
    gc.imageConfig ||
    gc.image_config ||
    {}) as Record<string, unknown>;
  return {
    model: asStr(body.model) || model,
    size: asStr(body.size),
    width: asNum(body.width) ?? asNum(ic.width),
    height: asNum(body.height) ?? asNum(ic.height),
    aspectRatio: asStr(ic.aspectRatio) || asStr(ic.aspect_ratio) || asStr(body.aspect_ratio) || asStr(body.aspectRatio),
    imageSize: asStr(ic.imageSize) || asStr(ic.image_size) || asStr(body.image_size) || asStr(body.imageSize),
  };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function closestAspect(w: number, h: number): ImageAspect {
  const r = w / h;
  let best: ImageAspect = "1:1";
  let dist = Infinity;
  for (const a of IMAGE_ASPECTS) {
    const [aw, ah] = a.split(":").map(Number);
    const d = Math.abs(r - aw / ah);
    if (d < dist) {
      dist = d;
      best = a;
    }
  }
  return best;
}

export function aspectFromPixels(w: number, h: number): ImageAspect {
  return closestAspect(w, h);
}

export function aspectFromSize(size?: string): ImageAspect {
  const s = (size || "").trim();
  if ((IMAGE_ASPECTS as readonly string[]).includes(s)) return s as ImageAspect;
  const m = s.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (m) return closestAspect(Number(m[1]), Number(m[2]));
  return "1:1";
}

export function canParseSize(raw?: string): boolean {
  const s = (raw || "").trim();
  if (!s) return false;
  if ((IMAGE_ASPECTS as readonly string[]).includes(s)) return true;
  if (/^(1K|2K|4K|auto|small|medium|large)$/i.test(s)) return true;
  if (/^\d+\s*[x×]\s*\d+$/i.test(s)) return true;
  return false;
}

function parseK(raw?: string): ImageK | undefined {
  const s = (raw || "").trim().toUpperCase();
  if (s === "1K" || s === "SMALL") return "1K";
  if (s === "2K" || s === "MEDIUM") return "2K";
  if (s === "4K" || s === "LARGE") return "4K";
  return undefined;
}

function kFromMax(max: number, family: ImageFamily): ImageK {
  if (family === "gpt") {
    if (max >= 2500) return "4K";
    if (max >= 1800) return "2K";
    return "1K";
  }
  if (max >= 3072) return "4K";
  if (max >= 1536) return "2K";
  return "1K";
}

export function tierOf(k: ImageK): ImageTier {
  if (k === "4K") return "Large";
  if (k === "2K") return "Medium";
  return "Small";
}

export function pixelsFor(aspect: ImageAspect, k: ImageK, family: ImageFamily): { w: number; h: number } {
  const [w1, h1] = NATIVE_1K[aspect] || NATIVE_1K["1:1"];
  if (k === "1K") return { w: w1, h: h1 };
  if (k === "2K") {
    if (family === "gpt") {
      const [w, h] = GPT_MEDIUM[aspect];
      return { w, h };
    }
    return { w: w1 * 2, h: h1 * 2 };
  }
  if (family === "gpt") {
    const [w, h] = GPT_LARGE[aspect];
    return { w, h };
  }
  return { w: w1 * 4, h: h1 * 4 };
}

const OPENAI_ALIAS: Record<string, { aspect: ImageAspect; k: ImageK }> = {
  "1024x1024": { aspect: "1:1", k: "1K" },
  "1536x1024": { aspect: "3:2", k: "1K" },
  "1024x1536": { aspect: "2:3", k: "1K" },
  "2048x2048": { aspect: "1:1", k: "2K" },
  "2048x1152": { aspect: "16:9", k: "1K" },
  "1152x2048": { aspect: "9:16", k: "1K" },
  "1792x1024": { aspect: "16:9", k: "1K" },
  "1024x1792": { aspect: "9:16", k: "1K" },
  "2880x2880": { aspect: "1:1", k: "4K" },
  "3840x2160": { aspect: "16:9", k: "4K" },
  "2160x3840": { aspect: "9:16", k: "4K" },
  "4096x4096": { aspect: "1:1", k: "4K" },
};

function exactNative(w: number, h: number): { aspect: ImageAspect; k: ImageK } | undefined {
  for (const aspect of IMAGE_ASPECTS) {
    for (const k of ["1K", "2K", "4K"] as ImageK[]) {
      for (const fam of ["gpt", "nano"] as ImageFamily[]) {
        const px = pixelsFor(aspect, k, fam);
        if (px.w === w && px.h === h) return { aspect, k };
      }
    }
  }
  return undefined;
}

export function resolveImageSpec(input: SizeInput): { ok: true; spec: ImageSpec } | { ok: false; error: string } {
  const family = imageFamily(input.model);
  const sizeRaw = (input.size || "").trim();
  const sizeKey = sizeRaw.replace(/×/g, "x").replace(/\s+/g, "");

  let aspect: ImageAspect | undefined;
  let k: ImageK | undefined;

  const fromImageSize = parseK(input.imageSize);
  if (fromImageSize) k = fromImageSize;

  const ar = (input.aspectRatio || "").trim();
  if ((IMAGE_ASPECTS as readonly string[]).includes(ar)) aspect = ar as ImageAspect;

  if (sizeKey) {
    if ((IMAGE_ASPECTS as readonly string[]).includes(sizeKey)) aspect = sizeKey as ImageAspect;
    else if (parseK(sizeKey)) k = parseK(sizeKey);
    else if (sizeKey.toLowerCase() === "auto") {
      aspect = aspect || "1:1";
      k = k || "1K";
    } else if (OPENAI_ALIAS[sizeKey]) {
      const alias = OPENAI_ALIAS[sizeKey];
      aspect = aspect || alias.aspect;
      k = k || alias.k;
    } else {
      const m = sizeKey.match(/^(\d+)x(\d+)$/i);
      if (!m) return { ok: false, error: `unsupported parameter: size ${input.size}` };
      const w = Number(m[1]);
      const h = Number(m[2]);
      const hit = exactNative(w, h);
      if (hit) {
        aspect = aspect || hit.aspect;
        k = k || hit.k;
      } else {
        aspect = aspect || closestAspect(w, h);
        k = k || kFromMax(Math.max(w, h), family);
      }
    }
  }

  if (typeof input.width === "number" && typeof input.height === "number" && input.width > 0 && input.height > 0) {
    aspect = aspect || closestAspect(input.width, input.height);
    k = k || kFromMax(Math.max(input.width, input.height), family);
  }

  aspect = aspect || "1:1";
  k = k || "1K";
  const px = pixelsFor(aspect, k, family === "gemini" ? "nano" : family);
  return {
    ok: true,
    spec: {
      size: `${px.w}x${px.h}`,
      width: px.w,
      height: px.h,
      aspect,
      tier: tierOf(k),
      imageSize: k,
      family,
    },
  };
}

export function resolutionOptionsFor(model: string, aspect: ImageAspect): ResolutionOption[] {
  const family = imageFamily(model);
  const fam = family === "gemini" ? "nano" : family;
  return (["1K", "2K", "4K"] as ImageK[]).map((k) => {
    const px = pixelsFor(aspect, k, fam);
    const tier = tierOf(k);
    return {
      k,
      tier,
      w: px.w,
      h: px.h,
      size: `${px.w}x${px.h}`,
      label: `${tier} ${px.w}×${px.h}`,
    };
  });
}

export function sizeOptionsFor(model: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const preset of ASPECT_PRESETS) {
    for (const r of resolutionOptionsFor(model, preset.id)) {
      if (seen.has(r.size)) continue;
      seen.add(r.size);
      const hint = preset.hint ? ` · ${preset.hint}` : "";
      out.push({ id: r.size, label: `${preset.label}${hint} · ${r.w}×${r.h} ${r.tier}` });
    }
  }
  return out;
}

void gcd;

export function compatibleNatives(spec: ImageSpec): { w: number; h: number }[] {
  const fam = spec.family === "gemini" ? "nano" : spec.family;
  const out: { w: number; h: number }[] = [pixelsFor(spec.aspect, spec.imageSize, fam)];
  for (const family of ["gpt", "nano"] as ImageFamily[]) {
    const px = pixelsFor(spec.aspect, spec.imageSize, family);
    if (!out.some((p) => p.w === px.w && p.h === px.h)) out.push(px);
  }
  for (const [alias, mapped] of Object.entries(OPENAI_ALIAS)) {
    if (mapped.aspect !== spec.aspect || mapped.k !== spec.imageSize) continue;
    const [w, h] = alias.split("x").map(Number);
    if (!w || !h) continue;
    if (!out.some((p) => p.w === w && p.h === h)) out.push({ w, h });
  }
  return out;
}

export function sizeMatchesSpec(width: number, height: number, spec: ImageSpec): boolean {
  if (width === spec.width && height === spec.height) return true;
  if (compatibleNatives(spec).some((p) => p.w === width && p.h === height)) return true;
  if (aspectFromPixels(width, height) !== spec.aspect) return false;
  const [aw, ah] = spec.aspect.split(":").map(Number);
  const expectedRatio = aw! / ah!;
  const ratioError = Math.abs(width / height - expectedRatio) / expectedRatio;
  if (ratioError > 0.035) return false;
  return kFromPixels(width, height, spec.family) === spec.imageSize;
}

export function kFromPixels(width: number, height: number, family: ImageFamily): ImageK {
  const area = width * height;
  const fam = family === "gemini" ? "nano" : family;
  if (fam === "gpt") {
    if (area >= 6_000_000) return "4K";
    if (area >= 2_000_000) return "2K";
    return "1K";
  }
  if (area >= 10_000_000) return "4K";
  if (area >= 2_000_000) return "2K";
  return "1K";
}
