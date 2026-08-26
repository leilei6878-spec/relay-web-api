import { createFileRoute } from "@tanstack/react-router";
import { chatgptAdapter, geminiAdapter, leonardoAdapter } from "@/lib/provider/index";

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

const MODELS = [
  ...chatgpt.models.map((id) =>
    asModel(id, "relay-chatgpt", chatgpt, id === "gpt-4o" ? "GPT-4o Vision" : "ChatGPT web, vision + multi-turn"),
  ),
  asModel("gemini-image", "relay-gemini", gemini, "Gemini 出图 / 参考图编辑（mask 不支持）"),
  asModel("leonardo-gpt-image-2", "relay-leonardo", leonardo, "Leonardo web GPT Image 2"),
  asModel("leonardo-gemini", "relay-leonardo", leonardo, "Leonardo web Gemini / Nano Banana family"),
];

export const Route = createFileRoute("/v1/models")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "authorization, content-type, x-api-key",
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
