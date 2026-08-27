import { persistImageBytes } from "./media-store";
import { uid } from "./utils";

export async function persistImageUrl(url: string): Promise<{ ok: true; id: string; path: string; url: string } | { ok: false; error: string }> {
  if (!url) return { ok: false, error: "empty image" };
  try {
    let buf: Buffer;
    let mime = "image/png";
    if (url.startsWith("data:")) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return { ok: false, error: "bad data url" };
      mime = m[1] || "image/png";
      buf = Buffer.from(m[2] || "", "base64");
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return { ok: false, error: `download ${res.status}` };
      mime = res.headers.get("content-type") || "image/png";
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      return { ok: false, error: "unsupported image url" };
    }
    const stored = await persistImageBytes(buf, mime);
    return { ok: true, id: stored.id, path: stored.url, url: stored.url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "persist failed" };
  }
}

export async function persistImageUrls(urls: string[]): Promise<{ ok: true; urls: string[] } | { ok: false; error: string }> {
  const out: string[] = [];
  for (const url of urls) {
    const stored = await persistImageUrl(url);
    if (!stored.ok) return stored;
    out.push(stored.url);
  }
  return { ok: true, urls: out };
}
