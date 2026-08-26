import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { createFileRoute } from "@tanstack/react-router";
import { getMediaStore } from "@/lib/media-store";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export const Route = createFileRoute("/api/media/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const id = (params.id || "").replace(/[^a-zA-Z0-9._-]/g, "");
        if (!id) return new Response("not found", { status: 404 });
        const store = getMediaStore();
        if (store.kind === "object") {
          const hit = await store.get(id);
          if (!hit) return new Response("not found", { status: 404 });
          return new Response(new Uint8Array(hit.buf), {
            headers: {
              "Content-Type": hit.mime,
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          });
        }
        const file = resolve("storage/objects", id);
        try {
          await stat(file);
        } catch {
          return new Response("not found", { status: 404 });
        }
        const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
        return new Response(stream, {
          headers: {
            "Content-Type": MIME[extname(id)] || "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      },
    },
  },
});
