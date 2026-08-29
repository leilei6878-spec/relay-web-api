import { createFileRoute } from "@tanstack/react-router";
import { commercialReadiness } from "@/lib/commercial-readiness";

export const Route = createFileRoute("/api/saas/readiness")({
  server: {
    handlers: {
      GET: async () => {
        const readiness = await commercialReadiness();
        return Response.json(
          {
            enabled: readiness.enabled,
            ready: readiness.ready,
            registrationEnabled: readiness.registrationEnabled,
            providers: Object.entries(readiness.officialProviders).filter(([, configured]) => configured).map(([provider]) => provider),
            activeProviders: readiness.activeProviders,
            missingProviderCredentials: readiness.missingProviderCredentials,
            activePrices: readiness.activePrices,
            missingCanaries: readiness.missingCanaries,
            evidenceTotal: readiness.evidenceTotal,
            missingEvidence: readiness.missingEvidence.length,
            onlineWorkers: readiness.onlineWorkers,
            gatewayReplicas: readiness.gatewayReplicas,
            offsiteBackupConfigured: readiness.offsiteBackupConfigured,
            legalApproved: readiness.legalApproved,
            adminMfaRequired: readiness.adminMfaRequired,
            adminMfaConfigured: readiness.adminMfaConfigured,
            paymentProvider: readiness.paymentProvider,
            paymentReady: readiness.paymentReady,
            taxMode: readiness.taxMode,
            blockers: readiness.blockers,
          },
          { status: readiness.ready || !readiness.enabled ? 200 : 503, headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
