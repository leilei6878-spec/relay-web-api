export function onlineWorkerCount(runtime: { workers?: { online?: boolean }[] } | null | undefined) {
  return (runtime?.workers || []).filter((worker) => worker.online).length;
}
