import { createFileRoute } from "@tanstack/react-router";
import { parseStripeWebhook, processStripeWebhook } from "@/lib/payments";

export const Route = createFileRoute("/api/webhooks/stripe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const declared = Number(request.headers.get("content-length") || 0);
        if (declared > 1_000_000) return Response.json({ received: false }, { status: 413 });
        try {
          // Signature verification must use the exact raw body before any JSON parsing.
          const rawBody = await request.text();
          const parsed = parseStripeWebhook(rawBody, request.headers.get("stripe-signature") || "");
          const result = await processStripeWebhook(parsed);
          return Response.json({ received: true, replay: result.replay });
        } catch (error) {
          const message = error instanceof Error ? error.message : "STRIPE_WEBHOOK_FAILED";
          const authentication = message.startsWith("STRIPE_SIGNATURE") || message === "STRIPE_WEBHOOK_SECRET_MISSING";
          return Response.json({ received: false, error: authentication ? "INVALID_SIGNATURE" : "EVENT_PROCESSING_FAILED" }, { status: authentication ? 400 : 422 });
        }
      },
    },
  },
});
