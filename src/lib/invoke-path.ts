const ALLOWED = new Set([
  "/v1/chat/completions",
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/responses",
  "/v1/models",
]);

export function normalizeInvokePath(rawPath: string) {
  if (ALLOWED.has(rawPath) || rawPath.startsWith("/v1beta/models/")) return rawPath;
  return "/v1/chat/completions";
}
