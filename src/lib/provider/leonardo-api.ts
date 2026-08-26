/**
 * Optional official Leonardo REST adapter.
 * NEVER used as the default backend. Web Account Pool stays browser-driven.
 * Official API credits are billed separately from the Leonardo web subscription.
 *
 * Credential must be LeonardoProductionApiCredential (LEONARDO_API_KEY).
 * Session cookies from the web app must not be reused here.
 */
const ENDPOINT = "https://cloud.leonardo.ai/api/rest/v2/generations";

const MODEL_IDS: Record<string, string> = {
  "leonardo-gpt-image-2": "gpt-image-2",
  "gpt-image-2": "gpt-image-2",
  "leonardo-gemini": process.env.LEONARDO_GEMINI_MODEL && process.env.LEONARDO_GEMINI_MODEL !== "auto"
    ? process.env.LEONARDO_GEMINI_MODEL
    : "gemini-image-2",
  "nano-banana-2": "nano-banana-2",
  "gemini-image-2": "gemini-image-2",
};

export async function officialLeonardoGenerate(input: {
  model: string;
  prompt: string;
  n?: number;
  width?: number;
  height?: number;
}): Promise<{ ok: false; error: string; backend_mode: "official_api" }> {
  const key = process.env.LEONARDO_API_KEY || "";
  if (!key) {
    return {
      ok: false,
      error: "LEONARDO_OFFICIAL_API: missing LeonardoProductionApiCredential",
      backend_mode: "official_api",
    };
  }
  const modelId = MODEL_IDS[input.model] || input.model;
  void ENDPOINT;
  void modelId;
  return {
    ok: false,
    error: "LEONARDO_OFFICIAL_API: official_api is not the production backend; web_account is required",
    backend_mode: "official_api",
  };
}
