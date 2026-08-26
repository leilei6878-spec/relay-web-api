export type ChatPart =
  | string
  | {
      type?: string;
      text?: string;
      image_url?: { url?: string } | string;
      image?: { url?: string } | string;
      url?: string;
    };

const MAX_IMAGES = 4;
const MAX_IMAGES_LEONARDO = 6;
const MAX_CHARS = 6_000_000;

function asUrl(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object" && value && "url" in value) {
    const url = (value as { url?: string }).url;
    return typeof url === "string" ? url.trim() : "";
  }
  return "";
}

function pushImage(list: string[], url: string, max = MAX_IMAGES) {
  if (!url) return;
  if (url.length > MAX_CHARS) return;
  if (!url.startsWith("data:image") && !url.startsWith("http://") && !url.startsWith("https://")) return;
  if (list.length >= max) return;
  list.push(url);
}

export function parseMessageContent(content: unknown): { text: string; images: string[] } {
  const images: string[] = [];
  if (typeof content === "string") return { text: content.trim(), images };
  if (!Array.isArray(content)) return { text: "", images };
  const texts: string[] = [];
  for (const part of content as ChatPart[]) {
    if (typeof part === "string") {
      if (part.trim()) texts.push(part.trim());
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.text) {
      if (part.text?.trim()) texts.push(part.text.trim());
    }
    if (part.type === "image_url" || part.image_url) pushImage(images, asUrl(part.image_url) || asUrl(part.url));
    if (part.type === "image" || part.image) pushImage(images, asUrl(part.image) || asUrl(part.url));
    if (part.type === "input_image") pushImage(images, asUrl(part.image_url) || asUrl(part.url));
  }
  return { text: texts.join("\n").trim(), images };
}

export function parseImageRequest(
  body: {
    prompt?: string;
    image?: unknown;
    image_url?: unknown;
    images?: unknown;
  },
  opts?: { maxImages?: number },
): { prompt: string; images: string[] } {
  const max = opts?.maxImages ?? MAX_IMAGES;
  const images: string[] = [];
  pushImage(images, asUrl(body.image), max);
  pushImage(images, asUrl(body.image_url), max);
  if (Array.isArray(body.images)) {
    for (const item of body.images) pushImage(images, asUrl(item), max);
  }
  return { prompt: (body.prompt || "").trim(), images };
}

export function defaultPrompt(kind: "chat" | "image", text: string, images: string[]) {
  if (text) return text;
  if (!images.length) return "";
  return kind === "chat" ? "请描述这张图片" : "根据参考图生成一张新图";
}

export { MAX_IMAGES, MAX_IMAGES_LEONARDO };
