import { getMediaStore } from "./media-store.ts";
import {
  detectMagicMime,
  loadImageBytes,
  readImageMeta,
} from "./provider/image-result-validator.ts";
import { sha256Hex } from "./provider/reference-verify.ts";

export type ReferenceAsset = {
  assetId: string;
  url: string;
  sha256: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  width: number;
  height: number;
};

export async function ingestReferenceImages(
  urls: string[],
  origin: string,
): Promise<{ ok: true; assets: ReferenceAsset[] } | { ok: false; error: string }> {
  const assets: ReferenceAsset[] = [];
  for (const url of urls) {
    const loaded = await loadImageBytes(url);
    if (!loaded.ok) return { ok: false, error: `REFERENCE_INVALID: ${loaded.error}` };
    const mime = detectMagicMime(loaded.buf);
    if (!mime) return { ok: false, error: "REFERENCE_INVALID: unsupported image bytes" };
    const meta = readImageMeta(loaded.buf);
    if (!meta) return { ok: false, error: "REFERENCE_INVALID: unreadable dimensions" };
    try {
      const stored = await getMediaStore().put(loaded.buf, mime);
      const stableUrl = stored.url.startsWith("/")
        ? new URL(stored.url, origin).toString()
        : stored.url;
      assets.push({
        assetId: stored.id,
        url: stableUrl,
        sha256: stored.sha256 || sha256Hex(loaded.buf),
        mime,
        bytes: stored.bytes,
        width: meta.width,
        height: meta.height,
      });
    } catch (error) {
      return {
        ok: false,
        error: `REFERENCE_STORE_FAILED: ${error instanceof Error ? error.message : "media store failed"}`,
      };
    }
  }
  return { ok: true, assets };
}
