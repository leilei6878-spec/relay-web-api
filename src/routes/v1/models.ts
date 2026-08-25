import { createFileRoute } from "@tanstack/react-router";

const MODELS = [
  { id: "gpt-5.6", object: "model", owned_by: "relay", description: "ChatGPT 最新，支持图片输入" },
  { id: "gpt-5", object: "model", owned_by: "relay", description: "GPT-5 Auto，支持图片输入" },
  { id: "gpt-5-thinking", object: "model", owned_by: "relay", description: "GPT-5 Thinking，支持图片输入" },
  { id: "gpt-4o", object: "model", owned_by: "relay", description: "GPT-4o Vision" },
  { id: "gemini-image", object: "model", owned_by: "relay", description: "Gemini 出图，支持参考图" },
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
