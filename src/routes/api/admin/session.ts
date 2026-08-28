import { createFileRoute } from "@tanstack/react-router";
import { handleAdminSessionGet, handleAdminSessionPost } from "@/lib/admin-session";

export const Route = createFileRoute("/api/admin/session")({
  server: {
    handlers: {
      GET: ({ request }) => handleAdminSessionGet(request),
      POST: ({ request }) => handleAdminSessionPost(request),
    },
  },
});
