/** Release identity. Bump SCHEMA_VERSION when adding migrations/*.sql. */

export const APP_VERSION = "0.9.0-rc1";
export const API_VERSION = "v1";
export const SCHEMA_VERSION = 4;
export const SELECTOR_PACK = {
  chatgpt: "chatgpt-v1",
  gemini: "gemini-v1",
} as const;
