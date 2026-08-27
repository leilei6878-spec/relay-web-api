import { createHash } from "node:crypto";
import { imageDimensions } from "./image-guard.ts";

export type ReferenceDescriptor = {
  sha256: string;
  mime: string;
  width: number;
  height: number;
  byteSize: number;
};

export function sha256Hex(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

export function describeReference(buf: Buffer, mime = "image/png"): ReferenceDescriptor {
  const dim = imageDimensions(buf);
  return {
    sha256: sha256Hex(buf),
    mime: (mime || "image/png").split(";")[0]!.trim().toLowerCase(),
    width: dim?.width || 0,
    height: dim?.height || 0,
    byteSize: buf.length,
  };
}

export function describeDataUrl(url: string): ReferenceDescriptor | null {
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  try {
    return describeReference(Buffer.from(m[2] || "", "base64"), m[1] || "image/png");
  } catch {
    return null;
  }
}

export function attachmentIncomplete(requested: number, attached: number) {
  if (requested <= 0) return null;
  if (attached === requested) return null;
  return `REFERENCE_ATTACH_INCOMPLETE: attached ${attached} requested ${requested}`;
}

export function resultIsReference(resultSha: string, referenceHashes: string[]) {
  if (!resultSha) return false;
  return referenceHashes.includes(resultSha);
}
