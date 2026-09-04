import { createFileRoute } from "@tanstack/react-router";
import { chatgptAdapter, geminiAdapter, leonardoAdapter } from "@/lib/provider/index";
import { OFFICIAL_GPT_IMAGE_IDS, OFFICIAL_NANO_IDS } from "@/lib/provider/leonardo-models";
import { bearerToken, classify } from "@/lib/authz";
import { getSql } from "@/lib/db";
import { CHATGPT_IMAGE_MODEL } from "@/lib/provider/chatgpt-image";

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
const chatgptImageCaps = { ...chatgpt, imageGeneration: true, imageEdit: true, chat: false, streaming: false, multiTurn: false };

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
  asModel(CHATGPT_IMAGE_MODEL, "relay-chatgpt", chatgptImageCaps, "ChatGPT Images through an uploaded ChatGPT web login session"),
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
      GET: async ({ request }) => {
        const principal = await classify(request);
        const presented = bearerToken(request);
        if (presented.startsWith("sk-saas-") && principal?.kind !== "commercial") {
          return Response.json(
            { error: { message: "Invalid commercial API key", type: "authentication_error" } },
            { status: 401, headers: { "Access-Control-Allow-Origin": "*" } },
          );
        }
        let data = MODELS;
        if (principal?.kind === "commercial") {
          const sql = await getSql();
          const prices = await sql.query<Record<string, unknown>>(
            `select distinct on (provider,model,capability) provider,model,capability,currency,
                    input_micros_per_million,output_micros_per_million,image_price_minor,markup_basis_points
               from relay_price_book where status='active' and effective_from <= now()
                 and (effective_to is null or effective_to > now())
              order by provider,model,capability,version desc`,
          );
          data = prices.map((price) => ({
            id: `${price.provider}:${price.model}`,
            object: "model",
            owned_by: price.provider,
            description: "Official commercial API model",
            capabilities: {
              chat: price.capability === "chat",
              vision: false,
              image_generation: price.capability === "image",
              image_edit: false,
              streaming: false,
              multi_turn: price.capability === "chat",
            },
            pricing: {
              currency: price.currency,
              input_micros_per_million: price.input_micros_per_million,
              output_micros_per_million: price.output_micros_per_million,
              image_price_minor: price.image_price_minor,
              markup_basis_points: price.markup_basis_points,
            },
          })) as typeof MODELS;
        }
        return Response.json(
          { object: "list", data },
          {
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      },
    },
  },
});
