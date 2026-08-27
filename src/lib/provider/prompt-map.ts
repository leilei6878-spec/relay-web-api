import { parseMessageContent } from "../media";
import type { ChatTurn, PreparedRequest, ProviderId } from "./types";

const MAX_TURNS = 24;
const MAX_TURN_CHARS = 8_000;

function asRole(value?: string): ChatTurn["role"] {
  if (value === "system" || value === "assistant" || value === "user") return value;
  return "user";
}

export function turnsFromMessages(
  messages?: { role?: string; content?: unknown }[],
  extraImages: string[] = [],
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const msg of messages || []) {
    const parsed = parseMessageContent(msg.content);
    const role = asRole(msg.role);
    const images = [...(parsed.images || [])];
    if (!parsed.text && !images.length) continue;
    turns.push({
      role,
      text: (parsed.text || "").slice(0, MAX_TURN_CHARS),
      images: images.length ? images : undefined,
    });
  }
  if (extraImages.length && turns.length) {
    const lastUser = [...turns].reverse().find((t) => t.role === "user");
    if (lastUser) lastUser.images = [...new Set([...(lastUser.images || []), ...extraImages])].slice(0, 4);
  } else if (extraImages.length) {
    turns.push({ role: "user", text: "", images: extraImages.slice(0, 4) });
  }
  return turns.slice(-MAX_TURNS);
}

/**
 * ChatGPT/Gemini web cannot inject a native OpenAI conversation.
 * This is the explicit conversion layer: role-delimited blocks, not a blob.
 */
export function toWebPrompt(turns: ChatTurn[], kind: PreparedRequest["kind"] = "chat"): string {
  if (!turns.length) return "";
  const last = turns[turns.length - 1];
  const prior = turns.slice(0, -1);
  if (!prior.length && last) {
    return last.text || (last.images?.length ? (kind === "image" || kind === "edit" ? "根据参考图生成一张新图" : "请描述这张图片") : "");
  }
  const blocks: string[] = [];
  for (const turn of prior) {
    const tag = turn.role.toUpperCase();
    const imgNote = turn.images?.length ? `\n[attached:${turn.images.length} image(s)]` : "";
    blocks.push(`<relay:${tag}>\n${turn.text}${imgNote}\n</relay:${tag}>`);
  }
  if (last) {
    const imgNote = last.images?.length ? `\n[attached:${last.images.length} image(s)]` : "";
    blocks.push(`<relay:${last.role.toUpperCase()} current="true">\n${last.text}${imgNote}\n</relay:${last.role.toUpperCase()}>`);
  }
  return blocks.join("\n\n").trim();
}

export function collectImages(turns: ChatTurn[], extra: string[] = []): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    for (const url of turn.images || []) {
      if (url && !out.includes(url)) out.push(url);
    }
  }
  for (const url of extra) {
    if (url && !out.includes(url)) out.push(url);
  }
  return out.slice(0, 4);
}

export function prepareChatRequest(
  provider: ProviderId,
  input: {
    messages?: { role?: string; content?: unknown }[];
    prompt?: string;
    model?: string;
    images?: string[];
    kind?: PreparedRequest["kind"];
    selectorPackVersion?: string;
  },
): PreparedRequest {
  const kind = input.kind || (provider === "gemini" ? "image" : "chat");
  let turns = turnsFromMessages(input.messages, input.images || []);
  if (!turns.length && input.prompt) {
    turns = [{ role: "user", text: input.prompt, images: input.images?.length ? input.images.slice(0, 4) : undefined }];
  }
  const images = collectImages(turns, input.images || []);
  const webPrompt = toWebPrompt(turns, kind);
  return {
    provider,
    model: input.model || (provider === "gemini" ? "gemini-image" : "chatgpt-web-auto"),
    webPrompt,
    turns,
    images,
    selectorPackVersion: input.selectorPackVersion || (provider === "gemini" ? "gemini-v1" : "chatgpt-v1"),
    kind,
  };
}
