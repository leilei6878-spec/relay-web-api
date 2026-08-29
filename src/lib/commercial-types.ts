export type TenantStatus = "trial" | "active" | "suspended" | "closed";
export type TenantRole = "owner" | "admin" | "billing" | "developer" | "viewer";
export type CommercialCapability = "chat" | "image";

export type Tenant = {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  planId: string;
  billingEmail: string;
  currency: string;
  balanceMinor: number;
  reservedMinor: number;
  creditLimitMinor: number;
  monthlyBudgetMinor: number;
  createdAt: string;
  updatedAt: string;
};

export type CommercialApiKey = {
  commercial: true;
  id: string;
  tenantId: string;
  tenantStatus: TenantStatus;
  tenantPlanId: string;
  name: string;
  enabled: boolean;
  scopes: CommercialCapability[];
  modelAllowlist: string[];
  requestsPerMinute: number;
  concurrencyLimit: number;
  dailyRequestLimit: number;
  dailyLimit: number;
  monthlySpendLimitMinor: number;
  expiresAt: string | null;
};

export type PriceBookRow = {
  id: string;
  version: number;
  provider: string;
  model: string;
  capability: CommercialCapability;
  currency: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  imagePriceMinor: number;
  markupBasisPoints: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "draft" | "active" | "retired";
};

export type UsageReservation = {
  chargeId: string;
  tenantId: string;
  requestId: string;
  reservedMinor: number;
  price: PriceBookRow;
  replay: boolean;
  status: "reserved" | "settled" | "released";
  chargedMinor: number;
  providerResultCiphertext?: string | null;
};
