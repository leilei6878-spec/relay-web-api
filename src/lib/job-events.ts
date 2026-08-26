type JobEvent =
  | { type: "delta"; text: string }
  | { type: "phase"; phase: string }
  | { type: "done"; text?: string; url?: string }
  | { type: "error"; error: string };

type Handler = (ev: JobEvent) => void;

const subs = new Map<string, Set<Handler>>();
const buffers = new Map<string, string>();

export function publishJobEvent(jobId: string, ev: JobEvent) {
  if (ev.type === "delta") {
    buffers.set(jobId, ((buffers.get(jobId) || "") + ev.text).slice(-32_000));
  }
  const set = subs.get(jobId);
  if (set) for (const h of set) h(ev);
}

export function subscribeJob(jobId: string, handler: Handler) {
  let set = subs.get(jobId);
  if (!set) {
    set = new Set();
    subs.set(jobId, set);
  }
  set.add(handler);
  const buffered = buffers.get(jobId);
  if (buffered) handler({ type: "delta", text: buffered });
  return () => {
    set!.delete(handler);
    if (set!.size === 0) subs.delete(jobId);
  };
}

export function jobBuffer(jobId: string) {
  return buffers.get(jobId) || "";
}

export function nextSseDelta(assembled: string, incoming: string) {
  if (!incoming) return "";
  if (incoming === assembled) return "";
  if (incoming.startsWith(assembled)) return incoming.slice(assembled.length);
  if (assembled.startsWith(incoming)) return "";
  let i = 0;
  const n = Math.min(assembled.length, incoming.length);
  while (i < n && assembled[i] === incoming[i]) i += 1;
  if (i >= Math.max(12, Math.floor(assembled.length * 0.5))) return incoming.slice(i);
  return "";
}

export function clearJobEvents(jobId: string) {
  subs.delete(jobId);
  buffers.delete(jobId);
}
