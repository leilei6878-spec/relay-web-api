CREATE TABLE IF NOT EXISTS relay_alert_deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES relay_alert_events(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_expires_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  http_status INTEGER,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alert_id,event_type),
  CHECK (event_type IN ('opened','resolved')),
  CHECK (status IN ('pending','retrying','not_configured','sending','delivered','superseded')),
  CHECK (attempts >= 0),
  CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (octet_length(payload::text) <= 16384),
  CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS relay_alert_deliveries_due_idx
  ON relay_alert_deliveries(next_attempt_at,created_at)
  WHERE status IN ('pending','retrying','not_configured');
CREATE INDEX IF NOT EXISTS relay_alert_deliveries_alert_idx
  ON relay_alert_deliveries(alert_id,created_at DESC);

INSERT INTO relay_meta(key,value) VALUES ('schema_version','16')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
