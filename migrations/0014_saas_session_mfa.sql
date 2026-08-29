ALTER TABLE relay_saas_sessions ADD COLUMN IF NOT EXISTS mfa_verified_at TIMESTAMPTZ;

INSERT INTO relay_meta(key,value) VALUES ('schema_version','14')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
