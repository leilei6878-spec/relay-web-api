ALTER TABLE relay_tenants ADD COLUMN IF NOT EXISTS included_balance_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_tenants ADD COLUMN IF NOT EXISTS included_reserved_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_tenants ADD COLUMN IF NOT EXISTS pending_plan_id TEXT REFERENCES relay_plans(id);
ALTER TABLE relay_tenants ADD COLUMN IF NOT EXISTS plan_change_effective_at TIMESTAMPTZ;

ALTER TABLE relay_usage_charges ADD COLUMN IF NOT EXISTS reserved_included_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_usage_charges ADD COLUMN IF NOT EXISTS charged_included_minor BIGINT NOT NULL DEFAULT 0;

ALTER TABLE relay_commercial_launch_evidence
  DROP CONSTRAINT IF EXISTS relay_commercial_launch_evidence_requirement_check;
ALTER TABLE relay_commercial_launch_evidence
  ADD CONSTRAINT relay_commercial_launch_evidence_requirement_check CHECK (requirement IN (
    'provider_rights','price_review','plan_review','legal_documents','tax_review',
    'payment_acceptance','email_delivery','ha_topology','offsite_restore',
    'alert_delivery','load_test_200','production_soak_24h','release_ci'
  ));

CREATE TABLE IF NOT EXISTS relay_plan_periods (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id),
  plan_id TEXT NOT NULL REFERENCES relay_plans(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL,
  monthly_fee_minor BIGINT NOT NULL,
  included_credit_minor BIGINT NOT NULL,
  expired_credit_minor BIGINT NOT NULL DEFAULT 0,
  transaction_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'settled',
  plan_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,period_start),
  CHECK (period_end > period_start),
  CHECK (monthly_fee_minor >= 0),
  CHECK (included_credit_minor >= 0),
  CHECK (expired_credit_minor >= 0),
  CHECK (status='settled')
);

CREATE INDEX IF NOT EXISTS relay_plan_periods_tenant_period
  ON relay_plan_periods(tenant_id,period_start DESC);

CREATE OR REPLACE FUNCTION relay_protect_plan_period()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'plan period ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS relay_plan_period_guard ON relay_plan_periods;
CREATE TRIGGER relay_plan_period_guard
BEFORE UPDATE OR DELETE ON relay_plan_periods
FOR EACH ROW EXECUTE FUNCTION relay_protect_plan_period();

INSERT INTO relay_meta(key,value) VALUES ('schema_version','13')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
