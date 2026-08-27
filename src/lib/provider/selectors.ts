import type { ProviderId, VersionedSelectorPack } from "./types";

/** Bounded packs. Never more than 3 candidates per slot. */
export const SELECTOR_PACKS: Record<string, VersionedSelectorPack> = {
  "chatgpt-v1": {
    version: "chatgpt-v1",
    input: ["textarea#prompt-textarea", "div[contenteditable='true']#prompt-textarea"],
    send: ["button[data-testid='send-button']", "button[aria-label='Send prompt']", "button[aria-label*='Send']"],
    assistant: ["div[data-message-author-role='assistant']"],
    streamingStop: ["button[data-testid='stop-button']", "button[aria-label='Stop generating']", "button[aria-label='Stop streaming']"],
    generationComplete: ["button[data-testid='copy-turn-action-button']", "button[aria-label*='Copy']", "button[data-testid='good-response']"],
    modelSwitcher: ['[data-testid="model-switcher-dropdown-button"]', 'button[aria-haspopup="menu"]'],
    fileInput: ["input[type=file]"],
  },
  "chatgpt-v2": {
    version: "chatgpt-v2",
    input: ["#prompt-textarea", "div[contenteditable='true'][data-virtualkeyboard]"],
    send: ["button[data-testid='send-button']", "button[aria-label*='Send']"],
    assistant: ["div[data-message-author-role='assistant']", "[data-testid='conversation-turn-3']"],
    streamingStop: ["button[data-testid='stop-button']", "button[aria-label*='Stop']"],
    generationComplete: ["button[data-testid='copy-turn-action-button']", "button[aria-label*='Copy']"],
    modelSwitcher: ['[data-testid="model-switcher-dropdown-button"]'],
    fileInput: ["input[type=file]"],
  },
  "leonardo-image-v1": {
    version: "leonardo-image-v1",
    input: ["#home-prompt-textarea", "textarea[placeholder*='prompt' i]", "textarea[placeholder*='Prompt']"],
    send: ['button[aria-label="Generate"]', 'button:has-text("Generate")', 'button:has-text("Create")'],
    assistant: [],
    streamingStop: [],
    modelSwitcher: ['button[aria-label^="Model:"]', '[data-slot="dropdown-menu-trigger"][aria-label^="Model"]'],
    fileInput: ['input[type=file]', 'button[aria-label="Add image reference"]', 'button[aria-label="Add reference to generation"]'],
    imageResult: ["img[src*='leonardo']", "img[src*='cdn']", "img[src^='https://']"],
  },
  "gemini-v1": {
    version: "gemini-v1",
    input: ["div.ql-editor", "rich-textarea", "div[contenteditable='true']"],
    send: ["button[aria-label*='Send']", "button[aria-label*='发送']"],
    assistant: ["model-response", "div.response-container"],
    streamingStop: ["button[aria-label*='Stop']"],
    fileInput: ["input[type=file]"],
    imageResult: ["img[src*='googleusercontent']", "img[src^='data:image']"],
  },
};

export const CURRENT_PACK: Record<ProviderId, string> = {
  chatgpt: "chatgpt-v1",
  gemini: "gemini-v1",
  leonardo: "leonardo-image-v1",
};

export function packFor(provider: ProviderId, version?: string): VersionedSelectorPack {
  const id = version && SELECTOR_PACKS[version] ? version : CURRENT_PACK[provider];
  const pack = SELECTOR_PACKS[id];
  if (!pack) throw new Error(`unknown selector pack ${id}`);
  return pack;
}

export function fallbackPack(provider: ProviderId, current: string): VersionedSelectorPack | null {
  if (provider === "chatgpt" && current === "chatgpt-v1") return SELECTOR_PACKS["chatgpt-v2"] ?? null;
  return null;
}

/** Walk primary then one fallback pack. Never unbounded. */
export function selectorCandidates(provider: ProviderId, slot: keyof VersionedSelectorPack, version?: string): string[] {
  const primary = packFor(provider, version);
  const list = [...((primary[slot] as string[] | undefined) || [])];
  const fb = fallbackPack(provider, primary.version);
  if (fb) {
    for (const s of (fb[slot] as string[] | undefined) || []) {
      if (!list.includes(s)) list.push(s);
    }
  }
  return list.slice(0, 4);
}
