CREATE TABLE IF NOT EXISTS relay_account_availability_samples (
  bucket_at TIMESTAMPTZ NOT NULL,
  platform TEXT NOT NULL,
  total INTEGER NOT NULL,
  available INTEGER NOT NULL,
  schedulable INTEGER NOT NULL,
  busy INTEGER NOT NULL,
  expiring_24h INTEGER NOT NULL,
  expiring_7d INTEGER NOT NULL,
  invalid INTEGER NOT NULL,
  ip_drift INTEGER NOT NULL,
  extra JSONB,
  PRIMARY KEY (bucket_at, platform)
);

CREATE INDEX IF NOT EXISTS relay_account_availability_samples_platform_idx
  ON relay_account_availability_samples (platform, bucket_at DESC);

INSERT INTO relay_meta (key, value)
VALUES ('schema_version', '6')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
