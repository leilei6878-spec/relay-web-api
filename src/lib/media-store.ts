import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isProduction, readEnv } from "./env-mode";
import { uid } from "./utils";

export type StoredMedia = {
  id: string;
  url: string;
  mime: string;
  bytes: number;
  sha256?: string;
  createdAt?: string;
  provider?: string;
  requestId?: string;
};

export interface MediaStore {
  kind: "local" | "object";
  put(buf: Buffer, mime: string): Promise<StoredMedia>;
  get(id: string): Promise<{ buf: Buffer; mime: string } | null>;
}

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);
const MAX_BYTES = 12 * 1024 * 1024;

export function validateMedia(buf: Buffer, mime: string) {
  const normalized = (mime || "").split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_MIME.has(normalized)) return { ok: false as const, error: `unsupported MIME ${normalized}` };
  if (!buf.length) return { ok: false as const, error: "empty image" };
  if (buf.length > MAX_BYTES) return { ok: false as const, error: "image too large" };
  return { ok: true as const, mime: normalized };
}

function extOf(mime: string) {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("svg")) return "svg";
  return "jpg";
}

function publicUrl(id: string, ext: string) {
  const path = `/api/media/${id}.${ext}`;
  const base = (process.env.RELAY_PUBLIC_URL || "").replace(/\/$/, "");
  return `${base}${path}`;
}

export class LocalMediaStore implements MediaStore {
  kind = "local" as const;
  dir: string;
  constructor(dir = resolve("storage", "objects")) {
    this.dir = dir;
  }
  async put(buf: Buffer, mime: string): Promise<StoredMedia> {
    const v = validateMedia(buf, mime);
    if (!v.ok) throw new Error(v.error);
    await mkdir(this.dir, { recursive: true });
    const id = uid();
    const ext = extOf(v.mime);
    const file = resolve(this.dir, `${id}.${ext}`);
    await writeFile(file, buf);
    return {
      id,
      url: publicUrl(id, ext),
      mime: v.mime,
      bytes: buf.length,
      sha256: sha256Hex(buf),
      createdAt: new Date().toISOString(),
    };
  }
  async get(id: string) {
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safe) return null;
    try {
      const buf = await readFile(resolve(this.dir, safe));
      const ext = safe.split(".").pop() || "png";
      const mime =
        ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : ext === "gif"
              ? "image/gif"
              : ext === "svg"
                ? "image/svg+xml"
                : "image/png";
      return { buf, mime };
    } catch {
      return null;
    }
  }
}

function hmac(key: Buffer | string, data: string) {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex");
}

/** Minimal AWS SigV4 PUT/GET for S3 / R2 / OSS / MinIO-compatible endpoints. */
export class ObjectMediaStore implements MediaStore {
  kind = "object" as const;
  cfg: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKey: string;
    secretKey: string;
    publicBase?: string;
  };
  constructor(cfg: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKey: string;
    secretKey: string;
    publicBase?: string;
  }) {
    this.cfg = cfg;
  }

  private host() {
    if (this.cfg.endpoint) {
      const u = new URL(this.cfg.endpoint);
      return u.host;
    }
    return `${this.cfg.bucket}.s3.${this.cfg.region}.amazonaws.com`;
  }

  private origin() {
    if (this.cfg.endpoint) return this.cfg.endpoint.replace(/\/$/, "");
    return `https://${this.host()}`;
  }

  private objectUrl(key: string) {
    if (this.cfg.endpoint) return `${this.origin()}/${this.cfg.bucket}/${key}`;
    return `https://${this.host()}/${key}`;
  }

  sign(method: string, key: string, body: Buffer, mime: string, at = new Date()) {
    const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body);
    const host = this.host();
    const canonicalUri = this.cfg.endpoint ? `/${this.cfg.bucket}/${key}` : `/${key}`;
    const canonicalHeaders = `content-type:${mime}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonical = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonical)}`;
    const kDate = hmac(`AWS4${this.cfg.secretKey}`, dateStamp);
    const kRegion = hmac(kDate, this.cfg.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return {
      url: this.objectUrl(key),
      headers: {
        Authorization: authorization,
        "Content-Type": mime,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        Host: host,
      },
    };
  }

  async put(buf: Buffer, mime: string): Promise<StoredMedia> {
    const v = validateMedia(buf, mime);
    if (!v.ok) throw new Error(v.error);
    const id = uid();
    const ext = extOf(v.mime);
    const key = `${id}.${ext}`;
    const signed = this.sign("PUT", key, buf, v.mime);
    const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: new Uint8Array(buf) });
    if (!res.ok) throw new Error(`object put ${res.status}`);
    const url = this.cfg.publicBase ? `${this.cfg.publicBase.replace(/\/$/, "")}/${key}` : publicUrl(id, ext);
    return { id, url, mime: v.mime, bytes: buf.length, sha256: sha256Hex(buf), createdAt: new Date().toISOString() };
  }

  async get(id: string) {
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safe) return null;
    const signed = this.sign("GET", safe, Buffer.alloc(0), "application/octet-stream");
    const res = await fetch(signed.url, { method: "GET", headers: signed.headers });
    if (!res.ok) return null;
    const mime = res.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf, mime };
  }
}

export function objectStoreConfigured(env: NodeJS.ProcessEnv = process.env) {
  const bucket = readEnv("RELAY_S3_BUCKET", env);
  const accessKey = readEnv("RELAY_S3_ACCESS_KEY", env) || readEnv("AWS_ACCESS_KEY_ID", env);
  const secretKey = readEnv("RELAY_S3_SECRET_KEY", env) || readEnv("AWS_SECRET_ACCESS_KEY", env);
  return Boolean(bucket && accessKey && secretKey);
}

let cached: MediaStore | null = null;

export function getMediaStore(): MediaStore {
  if (cached) return cached;
  if (objectStoreConfigured()) {
    cached = new ObjectMediaStore({
      bucket: readEnv("RELAY_S3_BUCKET"),
      region: readEnv("RELAY_S3_REGION") || "auto",
      endpoint: readEnv("RELAY_S3_ENDPOINT") || undefined,
      accessKey: readEnv("RELAY_S3_ACCESS_KEY") || readEnv("AWS_ACCESS_KEY_ID"),
      secretKey: readEnv("RELAY_S3_SECRET_KEY") || readEnv("AWS_SECRET_ACCESS_KEY"),
      publicBase: readEnv("RELAY_S3_PUBLIC_BASE") || undefined,
    });
    return cached;
  }
  if (isProduction()) {
    throw new Error("PRODUCTION_FAIL_CLOSED: object media store is required");
  }
  cached = new LocalMediaStore();
  return cached;
}

export function resetMediaStoreForTests() {
  cached = null;
}

export async function persistImageBytes(buf: Buffer, mime: string) {
  const store = getMediaStore();
  return store.put(buf, mime);
}
