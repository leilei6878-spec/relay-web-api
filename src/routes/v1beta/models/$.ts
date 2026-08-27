import { createFileRoute } from "@tanstack/react-router";
import { cors, handleImage, toB64 } from "@/routes/v1/images/generations";
import {
  geminiGenerateContentResponse,
  mimeFromDataUrl,
  parseGeminiGenerateContent,
  parseModelAction,
} from "@/lib/provider/gemini-api";

export const Route = createFileRoute("/v1beta/models/$")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors() }),
      POST: async ({ request, params }) => {
        const splat = String((params as { _splat?: string; $?: string })._splat || (params as { $?: string }).$ || "");
        return handleGenerateContent(request, splat);
      },
    },
  },
});

export async function handleGenerateContent(request: Request, splat: string): Promise<Response> {
        const { model, action } = parseModelAction(splat);
        if (action && !/generateContent|streamGenerateContent|predict/i.test(action)) {
          return Response.json(
            { error: { code: 400, message: `unsupported method ${action}`, status: "INVALID_ARGUMENT" } },
            { status: 400, headers: cors() },
          );
        }
        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return Response.json(
            { error: { code: 400, message: "JSON 无效", status: "INVALID_ARGUMENT" } },
            { status: 400, headers: cors() },
          );
        }
        const parsed = parseGeminiGenerateContent(body, model);
        const kind = parsed.images.length ? "edit" : "image";
        const headers = new Headers();
        for (const key of ["authorization", "x-api-key", "x-goog-api-key", "idempotency-key", "x-request-id"]) {
          const v = request.headers.get(key);
          if (v) headers.set(key, v);
        }
        headers.set("content-type", "application/json");
        const inner = new Request(request.url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            prompt: parsed.prompt,
            model: parsed.model,
            n: parsed.n,
            size: parsed.sizeInput.size,
            width: parsed.sizeInput.width,
            height: parsed.sizeInput.height,
            aspect_ratio: parsed.sizeInput.aspectRatio,
            image_size: parsed.sizeInput.imageSize,
            images: parsed.images,
            image: parsed.images[0],
            response_format: "b64_json",
          }),
        });
        const res = await handleImage(inner, kind);
        const json = (await res.json()) as {
          error?: { message?: string };
          data?: { b64_json?: string; url?: string }[];
        };
        if (!res.ok) {
          return Response.json(
            {
              error: {
                code: res.status,
                message: json.error?.message || "image generation failed",
                status: res.status === 401 ? "UNAUTHENTICATED" : res.status === 400 ? "INVALID_ARGUMENT" : "INTERNAL",
              },
            },
            { status: res.status, headers: cors() },
          );
        }
        const first = json.data?.[0];
        let b64 = first?.b64_json;
        let mime = "image/png";
        if (!b64 && first?.url) {
          mime = mimeFromDataUrl(first.url);
          b64 = await toB64(first.url);
        } else if (first?.url) {
          mime = mimeFromDataUrl(first.url);
        }
        if (!b64) {
          return Response.json(
            { error: { code: 502, message: "IMAGE_NOT_FOUND", status: "INTERNAL" } },
            { status: 502, headers: cors() },
          );
        }
        return Response.json(geminiGenerateContentResponse({ b64, mime, model: parsed.model }), { headers: cors() });
}
