CREATE TABLE IF NOT EXISTS relay_tenant_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id),
  actor_user_id TEXT NOT NULL REFERENCES relay_saas_users(id),
  actor_role TEXT NOT NULL,
  session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  outcome TEXT NOT NULL,
  error_code TEXT,
  request_id TEXT NOT NULL,
  ip_hmac TEXT NOT NULL,
  user_agent_hmac TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (actor_role IN ('owner','admin','billing','developer','viewer')),
  CHECK (outcome IN ('started','succeeded','failed')),
  CHECK (ip_hmac ~ '^[0-9a-f]{64}$'),
  CHECK (user_agent_hmac ~ '^[0-9a-f]{64}$'),
  CHECK (length(session_id) BETWEEN 8 AND 200),
  CHECK (length(operation_id) BETWEEN 8 AND 160),
  CHECK (length(action) BETWEEN 3 AND 120),
  CHECK (length(target_type) BETWEEN 3 AND 80),
  CHECK (target_id IS NULL OR length(target_id) BETWEEN 1 AND 200),
  CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120),
  CHECK (length(request_id) BETWEEN 8 AND 160),
  CHECK (octet_length(detail::text) <= 8192)
);

CREATE INDEX IF NOT EXISTS relay_tenant_audit_tenant_time
  ON relay_tenant_audit_events(tenant_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS relay_tenant_audit_actor_time
  ON relay_tenant_audit_events(actor_user_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS relay_tenant_audit_operation_outcome
  ON relay_tenant_audit_events(operation_id,outcome);

CREATE OR REPLACE FUNCTION relay_protect_tenant_audit_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tenant audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS relay_tenant_audit_guard ON relay_tenant_audit_events;
CREATE TRIGGER relay_tenant_audit_guard
BEFORE UPDATE OR DELETE ON relay_tenant_audit_events
FOR EACH ROW EXECUTE FUNCTION relay_protect_tenant_audit_event();

INSERT INTO relay_meta(key,value) VALUES ('schema_version','15')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
