export function estimateTokens(text: string) {
  const t = text || "";
  if (!t) return 0;
  return Math.max(1, Math.ceil(t.length / 4));
}
