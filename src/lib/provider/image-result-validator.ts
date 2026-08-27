import { createHash } from "node:crypto";
import { PRODUCTION_CONFIDENCE, type ResultConfidence } from "./generation-boundary.ts";
import { parseDataUrl } from "./image-guard.ts";
import {
  aspectFromPixels,
  kFromPixels,
  resolveImageSpec,
  sizeMatchesSpec,
  tierOf,
  type ImageFamily,
  type ImageSpec,
  type ImageTier,
} from "./image-size.ts";
import { resultIsReference, sha256Hex } from "./reference-verify.ts";

const MIN_BYTES = 2_048;
const MAX_BYTES = 20 * 1024 * 1024;
const MIN_EDGE = 64;

export type ImageBytes = {
  buf: Buffer;
  mime?: string;
  src?: string;
  confidence?: ResultConfidence;
  sha256?: string;
};

export type ImageValidationRequest = {
  n?: number;
  model?: string;
  size?: string;
  aspect?: string;
  tier?: string;
  family?: ImageFamily;
  referenceHashes?: string[];
  historicalHashes?: string[];
  confidences?: ResultConfidence[];
  requireConfidence?: boolean;
  spec?: ImageSpec;
};

export type ValidatedImage = {
  mime: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  actualAspect: string;
  actualTier: ImageTier;
  requestedSize: string;
  requestedTier: string;
  requestedAspect: string;
  confidence: ResultConfidence;
};

export type ImageValidationReport =
  | { ok: true; results: ValidatedImage[] }
  | { ok: false; error: string; results: ValidatedImage[] };

export function detectMagicMime(buf: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

export function readImageMeta(buf: Buffer): { width: number; height: number; type?: string } | null {
  const mime = detectMagicMime(buf);
  if (mime === "image/png") {
    if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height, type: "png" } : null;
  }
  if (mime === "image/webp") {
    if (buf.length < 30) return null;
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { width, height, type: "webp" };
    }
    if (chunk === "VP8 " && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return width > 0 && height > 0 ? { width, height, type: "webp" } : null;
    }
    if (chunk === "VP8L" && buf.length >= 25 && buf[20] === 0x2f) {
      const width = 1 + buf[21]! + ((buf[22]! & 0x3f) << 8);
      const height = 1 + ((buf[22]! & 0xc0) >> 6) + (buf[23]! << 2) + ((buf[24]! & 0x0f) << 10);
      return { width, height, type: "webp" };
    }
    return null;
  }
  if (mime === "image/jpeg") {
    const limit = Math.min(buf.length, 1024 * 1024);
    let offset = 2;
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 3 < limit) {
      while (offset < limit && buf[offset] !== 0xff) offset += 1;
      while (offset < limit && buf[offset] === 0xff) offset += 1;
      if (offset >= limit) return null;
      const marker = buf[offset]!;
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > limit) return null;
      const length = buf.readUInt16BE(offset);
      if (length < 2 || offset + length > limit) return null;
      if (startOfFrame.has(marker)) {
        if (length < 7) return null;
        const height = buf.readUInt16BE(offset + 3);
        const width = buf.readUInt16BE(offset + 5);
        return width > 0 && height > 0 ? { width, height, type: "jpg" } : null;
      }
      offset += length;
    }
  }
  return null;
}

function specFor(req: ImageValidationRequest): ImageSpec {
  if (req.spec) return req.spec;
  const resolved = resolveImageSpec({
    model: req.model,
    size: req.size,
    aspectRatio: req.aspect,
    imageSize: req.tier,
  });
  if (resolved.ok) return resolved.spec;
  return {
    size: req.size || "1024x1024",
    width: 1024,
    height: 1024,
    aspect: "1:1",
    tier: "Small",
    imageSize: "1K",
    family: req.family || "nano",
  };
}

export function validateOneImage(item: ImageBytes, req: ImageValidationRequest): { ok: true; result: ValidatedImage } | { ok: false; error: string } {
  const buf = item.buf;
  if (!buf?.length) return { ok: false, error: "IMAGE_NOT_FOUND: empty" };
  const magic = detectMagicMime(buf);
  if (!magic) return { ok: false, error: "IMAGE_NOT_FOUND: unsupported magic signature" };
  const claimed = (item.mime || magic).split(";")[0]!.trim().toLowerCase().replace("image/jpg", "image/jpeg");
  if (claimed && claimed !== magic && !(claimed === "image/jpg" && magic === "image/jpeg")) {
    return { ok: false, error: `IMAGE_NOT_FOUND: MIME ${claimed} does not match ${magic}` };
  }
  if (buf.length < MIN_BYTES) return { ok: false, error: "IMAGE_NOT_FOUND: image too small" };
  if (buf.length > MAX_BYTES) return { ok: false, error: "IMAGE_NOT_FOUND: image too large" };
  const dim = readImageMeta(buf);
  if (!dim) return { ok: false, error: "IMAGE_NOT_FOUND: unreadable dimensions" };
  if (dim.width < MIN_EDGE || dim.height < MIN_EDGE) {
    return { ok: false, error: `IMAGE_NOT_FOUND: ${dim.width}x${dim.height} below ${MIN_EDGE}px` };
  }
  const spec = specFor(req);
  const actualAspect = aspectFromPixels(dim.width, dim.height);
  if (!sizeMatchesSpec(dim.width, dim.height, spec)) {
    return {
      ok: false,
      error: `OUTPUT_SIZE_MISMATCH: requested ${spec.aspect} ${spec.size} got ${dim.width}x${dim.height} (${actualAspect})`,
    };
  }
  const sha = item.sha256 || sha256Hex(buf);
  if (resultIsReference(sha, req.referenceHashes || [])) {
    return { ok: false, error: "RESULT_IS_REFERENCE_IMAGE" };
  }
  if ((req.historicalHashes || []).includes(sha)) {
    return { ok: false, error: "IMAGE_NOT_FOUND: historical asset returned" };
  }
  if (!item.confidence && req.requireConfidence) {
    return { ok: false, error: "IMAGE_CONFIDENCE_TOO_LOW: MISSING" };
  }
  const conf = item.confidence || "HIGH";
  if (!PRODUCTION_CONFIDENCE.has(conf)) {
    return { ok: false, error: `IMAGE_CONFIDENCE_TOO_LOW: ${conf}` };
  }
  const family = spec.family;
  const actualK = kFromPixels(dim.width, dim.height, family);
  return {
    ok: true,
    result: {
      mime: magic,
      sha256: sha,
      bytes: buf.length,
      width: dim.width,
      height: dim.height,
      actualAspect,
      actualTier: tierOf(actualK),
      requestedSize: spec.size,
      requestedTier: spec.tier,
      requestedAspect: spec.aspect,
      confidence: conf,
    },
  };
}

export function validateImageResults(items: ImageBytes[], req: ImageValidationRequest): ImageValidationReport {
  const want = Math.max(1, Math.floor(req.n || 1));
  const results: ValidatedImage[] = [];
  for (const item of items) {
    const one = validateOneImage(item, req);
    if (!one.ok) return { ok: false, error: one.error, results };
    results.push(one.result);
  }
  if (results.length !== want) {
    return { ok: false, error: `RESULT_COUNT_MISMATCH: want ${want} got ${results.length}`, results };
  }
  return { ok: true, results };
}

export function bytesFromDataUrl(url: string): ImageBytes | null {
  const parsed = parseDataUrl(url);
  if (!parsed) return null;
  return { buf: parsed.buf, mime: parsed.mime, src: url, sha256: sha256Hex(parsed.buf) };
}

export async function loadImageBytes(url: string): Promise<{ ok: true } & ImageBytes | { ok: false; error: string }> {
  if (!url) return { ok: false, error: "IMAGE_NOT_FOUND: empty" };
  if (url.startsWith("data:")) {
    const parsed = bytesFromDataUrl(url);
    if (!parsed) return { ok: false, error: "IMAGE_NOT_FOUND: bad data url" };
    return { ok: true, ...parsed };
  }
  const media = url.match(/\/api\/media\/([^/?#]+)/);
  if (media) {
    const { getMediaStore } = await import("../media-store.ts");
    const got = await getMediaStore().get(media[1]);
    if (!got) return { ok: false, error: "IMAGE_NOT_FOUND: missing asset" };
    return { ok: true, buf: got.buf, mime: got.mime, src: url, sha256: sha256Hex(got.buf) };
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return { ok: false, error: `IMAGE_NOT_FOUND: download ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, buf, mime: res.headers.get("content-type") || "image/png", src: url, sha256: sha256Hex(buf) };
    } catch {
      return { ok: false, error: "IMAGE_NOT_FOUND: download failed" };
    }
  }
  return { ok: false, error: "IMAGE_NOT_FOUND: unsupported url" };
}

export function hashOf(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

export async function validateJobImageUrls(urls: string[], req: ImageValidationRequest): Promise<ImageValidationReport> {
  const loaded: ImageBytes[] = [];
  for (let index = 0; index < urls.length; index += 1) {
    const u = urls[index]!;
    const item = await loadImageBytes(u);
    if (!item.ok) return { ok: false, error: item.error, results: [] };
    loaded.push({ ...item, confidence: req.confidences?.[index] });
  }
  return validateImageResults(loaded, req);
}
