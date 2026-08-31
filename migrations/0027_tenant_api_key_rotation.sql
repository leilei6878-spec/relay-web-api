ALTER TABLE relay_tenant_api_keys
  ADD COLUMN IF NOT EXISTS previous_key_hash TEXT,
  ADD COLUMN IF NOT EXISTS previous_key_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rotation_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE relay_tenant_api_keys
  DROP CONSTRAINT IF EXISTS relay_tenant_api_keys_previous_pair_check;
ALTER TABLE relay_tenant_api_keys
  ADD CONSTRAINT relay_tenant_api_keys_previous_pair_check CHECK (
    (previous_key_hash IS NULL) = (previous_key_expires_at IS NULL)
  );

ALTER TABLE relay_tenant_api_keys
  DROP CONSTRAINT IF EXISTS relay_tenant_api_keys_rotation_count_check;
ALTER TABLE relay_tenant_api_keys
  ADD CONSTRAINT relay_tenant_api_keys_rotation_count_check CHECK (rotation_count >= 0);

ALTER TABLE relay_tenant_api_keys
  DROP CONSTRAINT IF EXISTS relay_tenant_api_keys_distinct_credentials_check;
ALTER TABLE relay_tenant_api_keys
  ADD CONSTRAINT relay_tenant_api_keys_distinct_credentials_check CHECK (
    previous_key_hash IS NULL OR previous_key_hash <> key_hash
  );

CREATE UNIQUE INDEX IF NOT EXISTS relay_tenant_api_keys_previous_hash
  ON relay_tenant_api_keys(previous_key_hash) WHERE previous_key_hash IS NOT NULL;

INSERT INTO relay_meta(key,value) VALUES ('schema_version','27')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
