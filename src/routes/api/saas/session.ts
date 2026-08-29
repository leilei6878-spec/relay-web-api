import { createFileRoute } from "@tanstack/react-router";
import {
  assertSaasSession,
  clearSaasCookies,
  confirmSaasMfa,
  getSaasSession,
  loginSaas,
  logoutSaas,
  registerSaasOwner,
  startSaasMfa,
  verifySaasEmail,
  requestSaasPasswordReset,
  resetSaasPassword,
  sendSaasVerification,
} from "@/lib/saas-auth";
import { cachedCommercialReadiness } from "@/lib/commercial-readiness";

function responseWithCookies(body: unknown, cookies: string[], status = 200) {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function statusFor(error: string) {
  if (/RATE_LIMITED/.test(error)) return 429;
  if (/INVALID_ORIGIN|CSRF/.test(error)) return 403;
  if (/INVALID_CREDENTIALS|MFA_REQUIRED/.test(error)) return 401;
  if (/unique|duplicate/i.test(error)) return 409;
  return 400;
}

export const Route = createFileRoute("/api/saas/session")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await getSaasSession(request);
        return session
          ? Response.json({ ok: true, user: { id: session.userId, email: session.email, name: session.name }, tenant: { id: session.tenantId, name: session.tenantName, status: session.tenantStatus, role: session.role } }, { headers: { "Cache-Control": "no-store" } })
          : Response.json({ ok: false, error: "SAAS_UNAUTHORIZED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
      },
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const action = String(body.action || "login");
        try {
          if (action === "register") {
            if (process.env.NODE_ENV === "production") {
              const readiness = await cachedCommercialReadiness();
              if (!readiness.registrationEnabled) {
                return Response.json({ ok: false, error: "REGISTRATION_DISABLED" }, { status: 503 });
              }
              if (!readiness.ready) {
                return Response.json({ ok: false, error: "COMMERCIAL_NOT_READY" }, { status: 503 });
              }
            }
            const result = await registerSaasOwner(
              {
                tenantName: String(body.tenantName || ""), ownerName: String(body.ownerName || ""),
                email: String(body.email || ""), password: String(body.password || ""), currency: String(body.currency || "USD"),
              },
              request,
            );
            return responseWithCookies({ ok: true, tenantId: result.tenantId, userId: result.userId, csrf: result.csrf, verificationRequired: result.verificationRequired }, result.cookies, 201);
          }
          if (action === "login") {
            const result = await loginSaas(
              { email: String(body.email || ""), password: String(body.password || ""), tenantId: body.tenantId ? String(body.tenantId) : undefined, totp: body.totp ? String(body.totp) : undefined },
              request,
            );
            return responseWithCookies({ ok: true, user: result.user, tenant: result.tenant, csrf: result.csrf }, result.cookies);
          }
          if (action === "verify-email") {
            return Response.json(await verifySaasEmail(String(body.token || ""), request));
          }
          if (action === "password-reset-request") {
            return Response.json(await requestSaasPasswordReset(String(body.email || ""), request));
          }
          if (action === "password-reset") {
            return Response.json(await resetSaasPassword(String(body.token || ""), String(body.password || ""), request));
          }
          if (action === "resend-verification") {
            return Response.json(await sendSaasVerification(String(body.email || ""), request));
          }
          const auth = await assertSaasSession(request, ["owner", "admin"], { requireCsrf: true });
          if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
          if (action === "mfa-start") return Response.json({ ok: true, ...(await startSaasMfa(auth.session)) });
          if (action === "mfa-confirm") {
            const result = await confirmSaasMfa(auth.session, String(body.code || ""));
            return Response.json(result, { status: result.ok ? 200 : 400 });
          }
          return Response.json({ ok: false, error: "UNKNOWN_ACTION" }, { status: 400 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "SAAS_AUTH_FAILED";
          return Response.json({ ok: false, error: message }, { status: statusFor(message) });
        }
      },
      DELETE: async ({ request }) => {
        const auth = await assertSaasSession(request, undefined, { requireCsrf: true });
        if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
        const cookies = await logoutSaas(request);
        return responseWithCookies({ ok: true }, cookies);
      },
    },
  },
});
