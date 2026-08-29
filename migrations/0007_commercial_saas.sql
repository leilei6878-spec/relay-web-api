CREATE TABLE IF NOT EXISTS relay_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  currency TEXT NOT NULL DEFAULT 'USD',
  monthly_fee_minor BIGINT NOT NULL DEFAULT 0,
  included_credit_minor BIGINT NOT NULL DEFAULT 0,
  limits JSONB NOT NULL DEFAULT '{}'::JSONB,
  features JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO relay_plans (id,name,status,currency,monthly_fee_minor,included_credit_minor,limits,features)
VALUES
  ('starter','Starter','active','USD',0,0,'{"requestsPerMinute":10,"concurrency":2,"monthlySpendMinor":0}'::JSONB,'{"chat":true,"image":true}'::JSONB),
  ('growth','Growth','active','USD',0,0,'{"requestsPerMinute":60,"concurrency":10,"monthlySpendMinor":0}'::JSONB,'{"chat":true,"image":true}'::JSONB)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS relay_tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'trial',
  plan_id TEXT NOT NULL DEFAULT 'starter' REFERENCES relay_plans(id),
  billing_email TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  balance_minor BIGINT NOT NULL DEFAULT 0,
  reserved_minor BIGINT NOT NULL DEFAULT 0,
  credit_limit_minor BIGINT NOT NULL DEFAULT 0,
  monthly_budget_minor BIGINT NOT NULL DEFAULT 0,
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()) + interval '1 month',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS relay_tenants_status_idx ON relay_tenants(status);
CREATE INDEX IF NOT EXISTS relay_tenants_plan_idx ON relay_tenants(plan_id);

CREATE TABLE IF NOT EXISTS relay_saas_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  email_verified_at TIMESTAMPTZ,
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret_ciphertext TEXT,
  recovery_codes_hash JSONB,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay_tenant_memberships (
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES relay_saas_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id)
);

CREATE INDEX IF NOT EXISTS relay_tenant_memberships_user_idx ON relay_tenant_memberships(user_id,status);

CREATE TABLE IF NOT EXISTS relay_tenant_invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES relay_saas_users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS relay_tenant_invites_pending_email
  ON relay_tenant_invites(tenant_id,email_normalized) WHERE accepted_at is null;

CREATE TABLE IF NOT EXISTS relay_saas_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES relay_saas_users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS relay_saas_sessions_user_idx ON relay_saas_sessions(user_id,expires_at DESC);
CREATE INDEX IF NOT EXISTS relay_saas_sessions_tenant_idx ON relay_saas_sessions(tenant_id,expires_at DESC);

CREATE TABLE IF NOT EXISTS relay_saas_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES relay_saas_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS relay_saas_verifications_user_idx ON relay_saas_verifications(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS relay_tenant_api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['chat','image']::TEXT[],
  model_allowlist TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  requests_per_minute INTEGER NOT NULL DEFAULT 0,
  concurrency_limit INTEGER NOT NULL DEFAULT 0,
  daily_request_limit INTEGER NOT NULL DEFAULT 0,
  monthly_spend_limit_minor BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_by TEXT REFERENCES relay_saas_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS relay_tenant_api_keys_tenant_idx ON relay_tenant_api_keys(tenant_id,enabled);

CREATE TABLE IF NOT EXISTS relay_price_book (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  capability TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  input_micros_per_million BIGINT NOT NULL DEFAULT 0,
  output_micros_per_million BIGINT NOT NULL DEFAULT 0,
  image_price_minor BIGINT NOT NULL DEFAULT 0,
  markup_basis_points INTEGER NOT NULL DEFAULT 0,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE (provider,model,capability,version)
);

CREATE INDEX IF NOT EXISTS relay_price_book_active_idx
  ON relay_price_book(provider,model,capability,effective_from DESC)
  WHERE status='active';

CREATE TABLE IF NOT EXISTS relay_orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  payment_provider TEXT NOT NULL DEFAULT 'manual',
  provider_reference TEXT,
  idempotency_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE (tenant_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS relay_orders_tenant_idx ON relay_orders(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS relay_billing_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id),
  order_id TEXT REFERENCES relay_orders(id),
  request_id TEXT,
  kind TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  balance_after_minor BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extra JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE (tenant_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS relay_billing_entries (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES relay_billing_transactions(id),
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id),
  account_code TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id,account_code)
);

CREATE INDEX IF NOT EXISTS relay_billing_transactions_tenant_idx
  ON relay_billing_transactions(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS relay_billing_entries_tenant_idx
  ON relay_billing_entries(tenant_id,created_at DESC);

CREATE OR REPLACE FUNCTION relay_forbid_billing_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'billing ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS relay_billing_transactions_immutable ON relay_billing_transactions;
CREATE TRIGGER relay_billing_transactions_immutable
BEFORE UPDATE OR DELETE ON relay_billing_transactions
FOR EACH ROW EXECUTE FUNCTION relay_forbid_billing_mutation();

DROP TRIGGER IF EXISTS relay_billing_entries_immutable ON relay_billing_entries;
CREATE TRIGGER relay_billing_entries_immutable
BEFORE UPDATE OR DELETE ON relay_billing_entries
FOR EACH ROW EXECUTE FUNCTION relay_forbid_billing_mutation();

CREATE TABLE IF NOT EXISTS relay_usage_charges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id),
  api_key_id TEXT REFERENCES relay_tenant_api_keys(id),
  request_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  capability TEXT NOT NULL,
  price_book_id TEXT REFERENCES relay_price_book(id),
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  images INTEGER NOT NULL DEFAULT 0,
  reserved_minor BIGINT NOT NULL DEFAULT 0,
  charged_minor BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE (tenant_id,request_id)
);

CREATE INDEX IF NOT EXISTS relay_usage_charges_tenant_idx ON relay_usage_charges(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS relay_commercial_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip_address TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS relay_commercial_audit_tenant_idx ON relay_commercial_audit(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS relay_alert_events (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  message TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  occurrences INTEGER NOT NULL DEFAULT 1,
  extra JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS relay_alert_events_open_fingerprint
  ON relay_alert_events(fingerprint) WHERE status='open';
CREATE INDEX IF NOT EXISTS relay_alert_events_seen_idx ON relay_alert_events(last_seen_at DESC);

ALTER TABLE relay_usage ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE relay_usage ADD COLUMN IF NOT EXISTS charge_id TEXT;
ALTER TABLE relay_usage ADD COLUMN IF NOT EXISTS price_book_id TEXT;

INSERT INTO relay_meta (key,value)
VALUES ('schema_version','7')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
