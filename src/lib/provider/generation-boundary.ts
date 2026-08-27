export type ResultConfidence = "VERIFIED" | "HIGH" | "MEDIUM" | "LOW" | "REJECT";

export type ResultCandidate = {
  src: string;
  containerId: string;
  createdAfterSubmit: boolean;
  isNewContainer: boolean;
  isNewSrc: boolean;
  domainMatch: boolean;
  width: number;
  height: number;
  bytes: number;
  mime: string;
  sha256: string;
  referenceDuplicate: boolean;
  historicalDuplicate: boolean;
};

export type GenerationBoundary = {
  requestId: string;
  attemptId: string;
  provider: string;
  submittedAt: number;
  baselineResultContainerIds: string[];
  baselineGenerationIds: string[];
  baselineAssetUrls: string[];
  baselineAssetHashes: string[];
  referenceHashes: string[];
};

const UI_HINT = /favicon|avatar|logo|sprite|icon|emoji|\/static\/|profile.?pic|user-photo/i;
const DOMAIN_OK = /googleusercontent|ggpht|leonardo\.ai|leonardocdn|leonardousercontent|oaidalleapiprodscus|blob:|data:image/i;

export const PRODUCTION_CONFIDENCE = new Set<ResultConfidence>(["VERIFIED", "HIGH"]);

export function isUiSrc(src: string) {
  return !src || UI_HINT.test(src) || src.startsWith("data:image/svg");
}

export function domainMatch(src: string, provider?: string) {
  if (src.startsWith("data:image") && src.length > 800) return true;
  if (src.startsWith("blob:")) return true;
  if (DOMAIN_OK.test(src)) return true;
  if (provider === "gemini" && /google/.test(src)) return true;
  if (provider === "leonardo" && /leonardo/.test(src)) return true;
  return false;
}

export function scoreCandidate(c: ResultCandidate): ResultConfidence {
  if (!c.src) return "REJECT";
  if (c.historicalDuplicate || c.referenceDuplicate) return "REJECT";
  if (isUiSrc(c.src)) return "REJECT";
  if (c.width > 0 && c.height > 0 && (c.width < 64 || c.height < 64)) return "REJECT";
  if (!c.isNewSrc && !c.isNewContainer) return "REJECT";
  if (c.isNewContainer && c.isNewSrc && c.createdAfterSubmit && c.domainMatch) return "VERIFIED";
  if (c.isNewSrc && c.domainMatch && (c.isNewContainer || c.createdAfterSubmit)) return "HIGH";
  if (c.isNewSrc) return "MEDIUM";
  return "LOW";
}

function rank(conf: ResultConfidence, c: ResultCandidate) {
  const base = conf === "VERIFIED" ? 400 : conf === "HIGH" ? 300 : conf === "MEDIUM" ? 200 : conf === "LOW" ? 100 : 0;
  return base + Math.min(50, Math.floor((c.width * c.height) / 20000)) + (c.isNewContainer ? 10 : 0);
}

export function pickAcceptedCandidates(cands: ResultCandidate[], n = 1): { picked: ResultCandidate[]; confidence: ResultConfidence[] } {
  const scored = cands
    .map((c) => ({ c, conf: scoreCandidate(c) }))
    .filter((x) => PRODUCTION_CONFIDENCE.has(x.conf))
    .sort((a, b) => rank(b.conf, b.c) - rank(a.conf, a.c));
  const slice = scored.slice(0, Math.max(1, n));
  return { picked: slice.map((x) => x.c), confidence: slice.map((x) => x.conf) };
}

export function emptyBoundary(partial?: Partial<GenerationBoundary>): GenerationBoundary {
  return {
    requestId: "",
    attemptId: "",
    provider: "",
    submittedAt: Date.now(),
    baselineResultContainerIds: [],
    baselineGenerationIds: [],
    baselineAssetUrls: [],
    baselineAssetHashes: [],
    referenceHashes: [],
    ...partial,
  };
}

type Kind = "new" | "hist" | "ref" | "avatar" | "logo";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function shuffle<T>(items: T[], rand: () => number) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** 5 history + 2 refs + avatar + logo + 1 new generation. */
export function syntheticPermutation(seed: number): ResultCandidate[] {
  const hist = Array.from({ length: 5 }, (_, i) => ({
    kind: "hist" as Kind,
    src: `https://lh3.googleusercontent.com/history-${i}`,
    containerId: `hist-${i}`,
  }));
  const refs = [
    { kind: "ref" as Kind, src: "https://lh3.googleusercontent.com/ref-a", containerId: "composer-ref" },
    { kind: "ref" as Kind, src: "https://lh3.googleusercontent.com/ref-b", containerId: "composer-ref" },
  ];
  const ui = [
    { kind: "avatar" as Kind, src: "https://lh3.googleusercontent.com/avatar.png", containerId: "nav" },
    { kind: "logo" as Kind, src: "https://www.gstatic.com/logo.png", containerId: "nav" },
  ];
  const neu = { kind: "new" as Kind, src: "https://lh3.googleusercontent.com/gen-NEW", containerId: "resp-new" };
  const items = shuffle([...hist, ...refs, ...ui, neu], lcg(seed + 1));
  const baseline = new Set([...hist, ...refs, ...ui].map((x) => x.src));
  return items.map((item) => ({
    src: item.src,
    containerId: item.containerId,
    createdAfterSubmit: item.kind === "new",
    isNewContainer: item.kind === "new",
    isNewSrc: !baseline.has(item.src) || item.kind === "new",
    domainMatch: domainMatch(item.src, "gemini"),
    width: item.kind === "avatar" || item.kind === "logo" ? 32 : 1376,
    height: item.kind === "avatar" || item.kind === "logo" ? 32 : 768,
    bytes: item.kind === "avatar" || item.kind === "logo" ? 400 : 180_000,
    mime: "image/png",
    sha256: item.kind + ":" + item.src,
    referenceDuplicate: item.kind === "ref",
    historicalDuplicate: item.kind === "hist",
  }));
}

export const SYNTHETIC_NEW_SRC = "https://lh3.googleusercontent.com/gen-NEW";
