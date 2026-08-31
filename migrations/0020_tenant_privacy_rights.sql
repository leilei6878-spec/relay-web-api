CREATE TABLE IF NOT EXISTS relay_privacy_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id),
  requested_by TEXT NOT NULL REFERENCES relay_saas_users(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  snapshot_sha256 TEXT,
  blocked_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind IN ('tenant_export','tenant_closure')),
  CHECK (status IN ('requested','blocked','cancelled','completed')),
  CHECK (snapshot_sha256 IS NULL OR snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (blocked_reason IS NULL OR length(blocked_reason) BETWEEN 1 AND 120),
  CHECK (due_at >= requested_at),
  CHECK ((status='cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status='completed') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS relay_privacy_requests_tenant_time
  ON relay_privacy_requests(tenant_id,requested_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS relay_privacy_requests_due
  ON relay_privacy_requests(due_at,id)
  WHERE kind='tenant_closure' AND status IN ('requested','blocked');
CREATE UNIQUE INDEX IF NOT EXISTS relay_privacy_requests_one_open_closure
  ON relay_privacy_requests(tenant_id)
  WHERE kind='tenant_closure' AND status IN ('requested','blocked');

CREATE TABLE IF NOT EXISTS relay_privacy_request_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES relay_privacy_requests(id),
  tenant_id TEXT NOT NULL REFERENCES relay_tenants(id),
  actor_user_id TEXT REFERENCES relay_saas_users(id),
  event_type TEXT NOT NULL,
  payload_sha256 TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (event_type IN ('requested','exported','blocked','cancelled','completed')),
  CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (octet_length(detail::text) <= 4096)
);

CREATE INDEX IF NOT EXISTS relay_privacy_request_events_request_time
  ON relay_privacy_request_events(request_id,created_at,id);
CREATE INDEX IF NOT EXISTS relay_privacy_request_events_tenant_time
  ON relay_privacy_request_events(tenant_id,created_at DESC,id DESC);

CREATE OR REPLACE FUNCTION relay_protect_privacy_request()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'privacy request cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR
     NEW.requested_by <> OLD.requested_by OR NEW.kind <> OLD.kind OR
     NEW.due_at <> OLD.due_at OR NEW.requested_at <> OLD.requested_at OR
     NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256 THEN
    RAISE EXCEPTION 'privacy request identity is immutable';
  END IF;
  IF OLD.status IN ('cancelled','completed') THEN
    RAISE EXCEPTION 'privacy request is terminal';
  END IF;
  IF NOT (
    (OLD.status='requested' AND NEW.status IN ('blocked','cancelled','completed')) OR
    (OLD.status='blocked' AND NEW.status IN ('cancelled','completed')) OR
    (OLD.status='blocked' AND NEW.status='blocked' AND NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason)
  ) THEN
    RAISE EXCEPTION 'privacy request transition is invalid';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS relay_privacy_request_guard ON relay_privacy_requests;
CREATE TRIGGER relay_privacy_request_guard
BEFORE UPDATE OR DELETE ON relay_privacy_requests
FOR EACH ROW EXECUTE FUNCTION relay_protect_privacy_request();

CREATE OR REPLACE FUNCTION relay_protect_privacy_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy request event is append-only';
END;
$$;

DROP TRIGGER IF EXISTS relay_privacy_event_guard ON relay_privacy_request_events;
CREATE TRIGGER relay_privacy_event_guard
BEFORE UPDATE OR DELETE ON relay_privacy_request_events
FOR EACH ROW EXECUTE FUNCTION relay_protect_privacy_event();

INSERT INTO relay_meta(key,value) VALUES ('schema_version','20')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
