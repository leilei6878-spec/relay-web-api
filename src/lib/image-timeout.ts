export const LEONARDO_JOB_TIMEOUT_MS = 300_000;
export const LEONARDO_API_WAIT_MS = 290_000;
export const CHATGPT_IMAGE_JOB_TIMEOUT_MS = 300_000;
export const CHATGPT_IMAGE_API_WAIT_MS = 290_000;
export const ADMIN_INVOKE_TIMEOUT_MS = 330_000;

function hasReferenceImage(payload: unknown) {
  if (!payload || typeof payload !== "object") return false;
  const body = payload as Record<string, unknown>;
  return Boolean(
    (Array.isArray(body.images) && body.images.length > 0) ||
      body.image ||
      body.image_url,
  );
}

export function invokeTimeoutMessage(path: string, payload?: unknown) {
  if (path === "/v1/images/generations" || path === "/v1/images/edits") {
    const edit = path === "/v1/images/edits" || hasReferenceImage(payload);
    return edit
      ? "TIMEOUT: 图生图超时，网关没有返回内容。请确认参考图已挂上后重试。"
      : "TIMEOUT: 文生图超时，网关没有返回内容。请稍后重试或检查账号生成状态。";
  }
  return "TIMEOUT: 对话在时限内没有返回。请稍后重试。";
}
