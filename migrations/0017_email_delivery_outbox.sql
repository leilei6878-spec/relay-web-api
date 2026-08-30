CREATE TABLE IF NOT EXISTS relay_email_deliveries (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  recipient_hmac TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_expires_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  http_status INTEGER,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind IN ('verify-email','password-reset','tenant-invite')),
  CHECK (status IN ('pending','retrying','not_configured','sending','delivered','expired','superseded')),
  CHECK (attempts >= 0),
  CHECK (recipient_hmac ~ '^[0-9a-f]{64}$'),
  CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (length(payload_ciphertext) BETWEEN 9 AND 30000),
  CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS relay_email_deliveries_due_idx
  ON relay_email_deliveries(next_attempt_at,created_at)
  WHERE status IN ('pending','retrying','not_configured');
CREATE INDEX IF NOT EXISTS relay_email_deliveries_status_idx
  ON relay_email_deliveries(status,updated_at DESC);

INSERT INTO relay_meta(key,value) VALUES ('schema_version','17')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
