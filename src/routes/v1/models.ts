import { createFileRoute } from "@tanstack/react-router";
import { chatgptAdapter, geminiAdapter, leonardoAdapter } from "@/lib/provider/index";
import { OFFICIAL_GPT_IMAGE_IDS, OFFICIAL_NANO_IDS } from "@/lib/provider/leonardo-models";

function asModel(id: string, owned: string, caps: ReturnType<typeof chatgptAdapter.capabilities>, description: string) {
  return {
    id,
    object: "model",
    owned_by: owned,
    description,
    capabilities: {
      chat: caps.chat,
      vision: caps.vision,
      image_generation: caps.imageGeneration,
      image_edit: caps.imageEdit,
      streaming: caps.streaming,
      multi_turn: caps.multiTurn,
    },
  };
}

const chatgpt = chatgptAdapter.capabilities();
const gemini = geminiAdapter.capabilities();
const leonardo = leonardoAdapter.capabilities();
const gptImageCaps = { ...leonardo, imageGeneration: true, imageEdit: true, chat: false };

export const MODELS = [
  ...chatgpt.models.map((id) =>
    asModel(
      id,
      "relay-chatgpt",
      chatgpt,
      id === "chatgpt-web-auto"
        ? "ChatGPT web default; actual model remains unknown unless the UI exposes an exact version"
        : id === "gpt-4o"
          ? "GPT-4o Vision; request fails closed unless the UI confirms 4o"
          : "ChatGPT web, vision + multi-turn; exact IDs fail closed unless confirmed by the UI",
    ),
  ),
  asModel("gemini-image", "relay-gemini", gemini, "Gemini 出图 / 参考图编辑（mask 不支持）"),
  asModel("leonardo-gpt-image-2", "relay-leonardo", leonardo, "Leonardo web GPT Image 2"),
  asModel("leonardo-gemini", "relay-leonardo", leonardo, "Leonardo web Gemini / Nano Banana family"),
  ...OFFICIAL_GPT_IMAGE_IDS.map((id) =>
    asModel(id, "openai", gptImageCaps, "OpenAI Images API compatible (GPT Image)"),
  ),
  ...OFFICIAL_NANO_IDS.map((id) =>
    asModel(id, "google", gptImageCaps, "Gemini / Nano Banana official generateContent + Images API"),
  ),
];

export const Route = createFileRoute("/v1/models")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "authorization, content-type, x-api-key, x-goog-api-key",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
          },
        }),
      GET: async () =>
        Response.json(
          { object: "list", data: MODELS },
          {
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
          },
        ),
    },
  },
});
