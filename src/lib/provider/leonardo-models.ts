import type { Account } from "../types";

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

export const LEONARDO_SIZES = ["1024x1024", "848x1264", "1264x848", "1376x768", "768x1376"] as const;
export const LEONARDO_QUALITY = ["LOW", "MEDIUM", "HIGH"] as const;

/** Aspect buttons verified on logged-out home (2026-08-26 recon). */
export const LEONARDO_ASPECTS = ["1:1", "2:3", "16:9", "4:3", "4:5", "9:16"] as const;

export const LEONARDO_MAX_REFS = 6;
export const LEONARDO_MAX_N = 8;
export const LEONARDO_BACKEND_DEFAULT = "web_account" as const;

export function isLeonardoModel(model: string) {
  return model.startsWith("leonardo-") || model === "gpt-image-2" || model.startsWith("nano-banana");
}

export function mapLogicalModel(model: string): {
  logical: LeonardoLogicalModel;
  webLabels: string[];
  webId: string;
} {
  const m = (model || "").toLowerCase();
  if (m.includes("gpt-image") || m === "leonardo-gpt-image-2") {
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

export function accountHasLeonardoModel(account: Pick<Account, "availableModels" | "platform">, model: string) {
  if (account.platform && account.platform !== "leonardo") return true;
  const listed = account.availableModels;
  if (!listed || listed.length === 0) return true;
  const mapped = mapLogicalModel(model);
  const needles = [mapped.logical, mapped.webId, ...mapped.webLabels].map((s) => s.toLowerCase());
  return listed.some((item) => {
    const x = item.toLowerCase();
    return needles.some((n) => x.includes(n) || n.includes(x));
  });
}

export function sizeToAspect(size: string): (typeof LEONARDO_ASPECTS)[number] {
  const [w, h] = (size || "1024x1024").split("x").map((n) => Number(n));
  if (!w || !h) return "1:1";
  const r = w / h;
  const options: [(typeof LEONARDO_ASPECTS)[number], number][] = [
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["16:9", 16 / 9],
    ["4:5", 4 / 5],
    ["2:3", 2 / 3],
    ["9:16", 9 / 16],
  ];
  let best: (typeof LEONARDO_ASPECTS)[number] = "1:1";
  let dist = Infinity;
  for (const [label, ar] of options) {
    const d = Math.abs(r - ar);
    if (d < dist) {
      dist = d;
      best = label;
    }
  }
  return best;
}

export function validateLeonardoParams(input: {
  n?: number;
  size?: string;
  quality?: string;
  images?: string[];
  logical: LeonardoLogicalModel;
}) {
  const n = input.n ?? 1;
  if (!Number.isFinite(n) || n < 1 || n > LEONARDO_MAX_N) {
    return { ok: false as const, error: "unsupported parameter: n must be 1-8" };
  }
  if (input.size && !LEONARDO_SIZES.includes(input.size as (typeof LEONARDO_SIZES)[number]) && !/^\d+x\d+$/.test(input.size)) {
    return { ok: false as const, error: `unsupported parameter: size ${input.size}` };
  }
  if (input.quality && !LEONARDO_QUALITY.includes(input.quality.toUpperCase() as (typeof LEONARDO_QUALITY)[number])) {
    return { ok: false as const, error: `unsupported parameter: quality ${input.quality}` };
  }
  if ((input.images?.length || 0) > LEONARDO_MAX_REFS) {
    return { ok: false as const, error: `unsupported parameter: images max ${LEONARDO_MAX_REFS}` };
  }
  const size = input.size || "1024x1024";
  return {
    ok: true as const,
    n,
    size,
    quality: (input.quality || "MEDIUM").toUpperCase(),
    aspect: sizeToAspect(size),
  };
}

export function leonardoBackendMode(): "web_account" | "official_api" {
  const raw = (process.env.LEONARDO_BACKEND_MODE || LEONARDO_BACKEND_DEFAULT).toLowerCase();
  return raw === "official_api" ? "official_api" : "web_account";
}
