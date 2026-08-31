ALTER TABLE relay_tenant_invites
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by TEXT REFERENCES relay_saas_users(id),
  ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS send_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE relay_tenant_invites
   SET last_sent_at=created_at,
       updated_at=GREATEST(created_at,COALESCE(accepted_at,created_at));

ALTER TABLE relay_tenant_invites
  DROP CONSTRAINT IF EXISTS relay_tenant_invites_terminal_check;
ALTER TABLE relay_tenant_invites
  ADD CONSTRAINT relay_tenant_invites_terminal_check
  CHECK (accepted_at IS NULL OR revoked_at IS NULL);

ALTER TABLE relay_tenant_invites
  DROP CONSTRAINT IF EXISTS relay_tenant_invites_send_count_check;
ALTER TABLE relay_tenant_invites
  ADD CONSTRAINT relay_tenant_invites_send_count_check CHECK (send_count >= 1);

DROP INDEX IF EXISTS relay_tenant_invites_pending_email;
CREATE UNIQUE INDEX relay_tenant_invites_pending_email
  ON relay_tenant_invites(tenant_id,email_normalized)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS relay_tenant_invites_tenant_state
  ON relay_tenant_invites(tenant_id,created_at DESC);

INSERT INTO relay_meta(key,value) VALUES ('schema_version','26')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
