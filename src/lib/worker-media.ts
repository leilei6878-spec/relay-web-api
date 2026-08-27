import { getJob } from "./job-queue";
import { assertLease } from "./leases";
import { persistImageBytes } from "./media-store";
import { detectMagicMime, readImageMeta } from "./provider/image-result-validator";
import { sha256Hex } from "./provider/reference-verify";

export type WorkerMediaOk = {
  ok: true;
  assetId: string;
  url: string;
  sha256: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  mediaStoreMs: number;
  workerMediaUploadMs: number;
};

export async function ingestWorkerMedia(input: {
  jobId: string;
  attemptId?: string;
  leaseId?: string;
  fencingToken?: number;
  workerId?: string;
  buf: Buffer;
  mime?: string;
}): Promise<WorkerMediaOk | { ok: false; error: string; status: number }> {
  const started = Date.now();
  if (!input.jobId) return { ok: false, error: "缺少 job_id", status: 400 };
  if (!input.buf?.length) return { ok: false, error: "empty image", status: 400 };
  const job = await getJob(input.jobId);
  if (!job) return { ok: false, error: "job not found", status: 404 };
  const lease = assertLease(job.lease, {
    leaseId: input.leaseId,
    fencingToken: input.fencingToken,
    attemptId: input.attemptId,
    workerId: input.workerId,
  });
  if (!lease.ok) return { ok: false, error: lease.error, status: 409 };
  const magic = detectMagicMime(input.buf);
  if (!magic) return { ok: false, error: "IMAGE_NOT_FOUND: unsupported magic signature", status: 400 };
  const dim = readImageMeta(input.buf);
  const storeStarted = Date.now();
  let stored;
  try {
    stored = await persistImageBytes(input.buf, magic);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "media store failed", status: 500 };
  }
  return {
    ok: true,
    assetId: stored.id,
    url: stored.url,
    sha256: stored.sha256 || sha256Hex(input.buf),
    mime: stored.mime,
    bytes: stored.bytes,
    width: dim?.width || 0,
    height: dim?.height || 0,
    mediaStoreMs: Date.now() - storeStarted,
    workerMediaUploadMs: Date.now() - started,
  };
}
