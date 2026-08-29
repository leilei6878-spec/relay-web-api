ALTER TABLE relay_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE relay_orders ADD COLUMN IF NOT EXISTS checkout_url TEXT;
ALTER TABLE relay_orders ADD COLUMN IF NOT EXISTS provider_session_id TEXT;
ALTER TABLE relay_orders ADD COLUMN IF NOT EXISTS provider_payment_intent TEXT;
ALTER TABLE relay_orders ADD COLUMN IF NOT EXISTS checkout_expires_at TIMESTAMPTZ;
ALTER TABLE relay_orders ADD COLUMN IF NOT EXISTS refunded_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_orders ADD COLUMN IF NOT EXISTS tax_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_orders ADD COLUMN IF NOT EXISTS gross_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_orders ADD COLUMN IF NOT EXISTS refunded_tax_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_orders ADD COLUMN IF NOT EXISTS refunded_gross_minor BIGINT NOT NULL DEFAULT 0;

UPDATE relay_orders SET gross_minor=amount_minor WHERE gross_minor=0;

CREATE UNIQUE INDEX IF NOT EXISTS relay_orders_provider_session_uidx
  ON relay_orders(payment_provider,provider_session_id)
  WHERE provider_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS relay_orders_provider_intent_uidx
  ON relay_orders(payment_provider,provider_payment_intent)
  WHERE provider_payment_intent IS NOT NULL;

CREATE TABLE IF NOT EXISTS relay_payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  livemode BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'received',
  payload_sha256 TEXT NOT NULL,
  signature_timestamp BIGINT,
  order_id TEXT REFERENCES relay_orders(id),
  amount_minor BIGINT,
  currency TEXT,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE(provider,provider_event_id)
);

CREATE INDEX IF NOT EXISTS relay_payment_events_status_idx
  ON relay_payment_events(status,created_at DESC);

CREATE TABLE IF NOT EXISTS relay_payment_refunds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id),
  order_id TEXT NOT NULL REFERENCES relay_orders(id),
  provider TEXT NOT NULL,
  provider_refund_id TEXT,
  provider_payment_intent TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  credit_minor BIGINT NOT NULL CHECK (credit_minor > 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  reservation_minor BIGINT NOT NULL DEFAULT 0 CHECK (reservation_minor >= 0),
  currency TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE(tenant_id,idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS relay_payment_refunds_provider_uidx
  ON relay_payment_refunds(provider,provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS relay_payment_refunds_order_idx
  ON relay_payment_refunds(order_id,created_at DESC);

CREATE TABLE IF NOT EXISTS relay_payment_disputes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id),
  order_id TEXT NOT NULL REFERENCES relay_orders(id),
  provider TEXT NOT NULL,
  provider_dispute_id TEXT NOT NULL,
  provider_payment_intent TEXT,
  provider_charge_id TEXT,
  status TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  funds_withdrawn BOOLEAN NOT NULL DEFAULT false,
  funds_reinstated BOOLEAN NOT NULL DEFAULT false,
  evidence_due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE(provider,provider_dispute_id)
);

CREATE INDEX IF NOT EXISTS relay_payment_disputes_status_idx
  ON relay_payment_disputes(status,updated_at DESC);

CREATE OR REPLACE FUNCTION relay_protect_order_payment_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.provider_session_id IS NOT NULL AND
     (NEW.tenant_id <> OLD.tenant_id OR NEW.amount_minor <> OLD.amount_minor OR
      NEW.currency <> OLD.currency OR NEW.payment_provider <> OLD.payment_provider) THEN
    RAISE EXCEPTION 'settled payment identity is immutable';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS relay_orders_payment_identity ON relay_orders;
CREATE TRIGGER relay_orders_payment_identity
BEFORE UPDATE ON relay_orders
FOR EACH ROW EXECUTE FUNCTION relay_protect_order_payment_fields();

INSERT INTO relay_meta(key,value) VALUES ('schema_version','8')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
