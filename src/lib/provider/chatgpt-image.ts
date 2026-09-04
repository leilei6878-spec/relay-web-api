export const CHATGPT_IMAGE_MODEL = "chatgpt-llm-image";

export function isChatGptImageModel(model?: string) {
  return String(model || "").trim().toLowerCase() === CHATGPT_IMAGE_MODEL;
}

export function chatGptImagePrompt(input: {
  prompt: string;
  aspect: string;
  size: string;
  hasReferences: boolean;
}) {
  const task = input.hasReferences
    ? "Use the attached image or images as visual references and create a new edited or reimagined image."
    : "Create a new image from the request below.";
  return [
    task,
    "Return exactly one generated image, not only a written description.",
    `Required canvas aspect ratio: ${input.aspect}.`,
    `Target output resolution: ${input.size}.`,
    "Preserve the requested composition and do not add borders to fake the aspect ratio.",
    "User request:",
    input.prompt,
  ].join("\n");
}
