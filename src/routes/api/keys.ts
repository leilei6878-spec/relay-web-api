import { createFileRoute } from "@tanstack/react-router";
import { createApiKey, listApiKeys, patchApiKey, publicKey } from "@/lib/api-keys";
import { assertApiKey } from "@/lib/control-plane";
import { usageToday } from "@/lib/usage";

export const Route = createFileRoute("/api/keys")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await assertApiKey(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const keys = await listApiKeys();
        const data = await Promise.all(
          keys.map(async (k) => ({ ...publicKey(k), usedToday: await usageToday(k.id) })),
        );
        return Response.json({ keys: data });
      },
      POST: async ({ request }) => {
        const auth = await assertApiKey(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as {
          name?: string;
          dailyLimit?: number;
          scopes?: ("chat" | "image")[];
        };
        const row = await createApiKey({
          name: body.name || "新密钥",
          dailyLimit: body.dailyLimit,
          scopes: body.scopes,
        });
        return Response.json({ key: publicKey(row), secret: row.key });
      },
      PATCH: async ({ request }) => {
        const auth = await assertApiKey(request);
        if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as {
          id?: string;
          enabled?: boolean;
          name?: string;
          dailyLimit?: number;
        };
        if (!body.id) return Response.json({ error: "缺少 id" }, { status: 400 });
        const r = await patchApiKey(body.id, {
          enabled: body.enabled,
          name: body.name,
          dailyLimit: body.dailyLimit,
        });
        if (!r.ok) return Response.json({ error: r.error }, { status: 404 });
        return Response.json({ key: publicKey(r.key) });
      },
    },
  },
});
