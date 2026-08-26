const MIN_EDGE = 64;
const MIN_BYTES = 2_048;
const MAX_BYTES = 12 * 1024 * 1024;

const UI_HINT = /favicon|avatar|logo|sprite|icon|emoji|static\/|\/nav\/|profile.?pic|user-photo/i;

export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  return pngSize(buf) || jpegSize(buf);
}

export function isUiOrOldSrc(src: string, baseline: Set<string> | string[] = []) {
  const set = baseline instanceof Set ? baseline : new Set(baseline);
  if (!src) return true;
  if (set.has(src)) return true;
  if (UI_HINT.test(src)) return true;
  if (src.startsWith("data:image/svg")) return true;
  if (src.startsWith("data:image") && src.length < 400) return true;
  return false;
}

export function assertGeneratedBytes(buf: Buffer, mime: string, opts?: { allowSvg?: boolean }): { ok: true; mime: string; width?: number; height?: number } | { ok: false; error: string } {
  const normalized = (mime || "").split(";")[0]!.trim().toLowerCase();
  if (normalized.includes("svg") && !opts?.allowSvg) {
    return { ok: false, error: "IMAGE_NOT_FOUND: svg placeholder rejected" };
  }
  if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(normalized)) {
    return { ok: false, error: `IMAGE_NOT_FOUND: unsupported MIME ${normalized}` };
  }
  if (buf.length < MIN_BYTES) return { ok: false, error: "IMAGE_NOT_FOUND: image too small" };
  if (buf.length > MAX_BYTES) return { ok: false, error: "IMAGE_NOT_FOUND: image too large" };
  const dim = imageDimensions(buf);
  if (dim && (dim.width < MIN_EDGE || dim.height < MIN_EDGE)) {
    return { ok: false, error: `IMAGE_NOT_FOUND: ${dim.width}x${dim.height} below ${MIN_EDGE}px` };
  }
  return { ok: true, mime: normalized, width: dim?.width, height: dim?.height };
}

export function parseDataUrl(url: string): { mime: string; buf: Buffer } | null {
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  try {
    return { mime: m[1] || "image/png", buf: Buffer.from(m[2] || "", "base64") };
  } catch {
    return null;
  }
}

export function assertGeneratedImage(
  url?: string,
  opts?: { allowSvg?: boolean; baseline?: string[] },
): { ok: true; url: string } | { ok: false; error: string } {
  if (!url) return { ok: false, error: "IMAGE_NOT_FOUND: empty" };
  if (isUiOrOldSrc(url, opts?.baseline || [])) return { ok: false, error: "IMAGE_NOT_FOUND: ui or stale image" };
  if (url.startsWith("data:")) {
    const parsed = parseDataUrl(url);
    if (!parsed) return { ok: false, error: "IMAGE_NOT_FOUND: bad data url" };
    const gate = assertGeneratedBytes(parsed.buf, parsed.mime, opts);
    if (!gate.ok) return gate;
    return { ok: true, url };
  }
  if (url.startsWith("/api/media/") || url.startsWith("http://") || url.startsWith("https://")) {
    return { ok: true, url };
  }
  return { ok: false, error: "IMAGE_NOT_FOUND: unsupported url" };
}
