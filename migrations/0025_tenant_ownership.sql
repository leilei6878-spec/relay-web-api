CREATE TABLE IF NOT EXISTS relay_tenant_ownership (
  tenant_id TEXT PRIMARY KEY REFERENCES relay_tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,user_id) REFERENCES relay_tenant_memberships(tenant_id,user_id) ON DELETE RESTRICT
);

INSERT INTO relay_tenant_ownership(tenant_id,user_id,changed_by,changed_at)
SELECT DISTINCT ON (tenant_id) tenant_id,user_id,user_id,now()
  FROM relay_tenant_memberships
 WHERE role='owner' AND status='active'
 ORDER BY tenant_id,created_at,user_id
ON CONFLICT (tenant_id) DO NOTHING;

UPDATE relay_tenant_memberships m SET role='admin',updated_at=now()
 WHERE m.role='owner' AND NOT EXISTS (
   SELECT 1 FROM relay_tenant_ownership o WHERE o.tenant_id=m.tenant_id AND o.user_id=m.user_id
 );

CREATE OR REPLACE FUNCTION relay_enforce_designated_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE designated TEXT;
BEGIN
  SELECT user_id INTO designated FROM relay_tenant_ownership
   WHERE tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id);
  IF TG_OP='DELETE' THEN
    IF designated=OLD.user_id THEN RAISE EXCEPTION 'designated owner cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND designated=OLD.user_id AND (NEW.role<>'owner' OR NEW.status<>'active') THEN
    RAISE EXCEPTION 'designated owner requires atomic transfer';
  END IF;
  IF NEW.role='owner' AND NEW.status='active' AND designated IS NOT NULL AND designated<>NEW.user_id THEN
    RAISE EXCEPTION 'owner role requires atomic transfer';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS relay_tenant_owner_guard ON relay_tenant_memberships;
CREATE TRIGGER relay_tenant_owner_guard
BEFORE INSERT OR UPDATE OR DELETE ON relay_tenant_memberships
FOR EACH ROW EXECUTE FUNCTION relay_enforce_designated_owner();

CREATE OR REPLACE FUNCTION relay_register_initial_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE designated TEXT;
BEGIN
  IF NEW.role='owner' AND NEW.status='active' THEN
    INSERT INTO relay_tenant_ownership(tenant_id,user_id,changed_by,changed_at)
    VALUES (NEW.tenant_id,NEW.user_id,NEW.user_id,now())
    ON CONFLICT (tenant_id) DO NOTHING;
    SELECT user_id INTO designated FROM relay_tenant_ownership WHERE tenant_id=NEW.tenant_id;
    IF designated<>NEW.user_id THEN RAISE EXCEPTION 'tenant already has a designated owner'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS relay_tenant_owner_register ON relay_tenant_memberships;
CREATE TRIGGER relay_tenant_owner_register
AFTER INSERT ON relay_tenant_memberships
FOR EACH ROW EXECUTE FUNCTION relay_register_initial_owner();

CREATE OR REPLACE FUNCTION relay_transfer_tenant_ownership(p_tenant TEXT,p_source TEXT,p_target TEXT)
RETURNS TABLE(previous_owner TEXT,new_owner TEXT) LANGUAGE plpgsql AS $$
DECLARE current_owner TEXT;
BEGIN
  IF p_source=p_target THEN RAISE EXCEPTION 'ownership target must differ'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant,0));
  SELECT user_id INTO current_owner FROM relay_tenant_ownership WHERE tenant_id=p_tenant FOR UPDATE;
  IF current_owner IS DISTINCT FROM p_source THEN RAISE EXCEPTION 'ownership source mismatch'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM relay_tenant_memberships m JOIN relay_saas_users u ON u.id=m.user_id
     WHERE m.tenant_id=p_tenant AND m.user_id=p_target AND m.status='active'
       AND u.status='active' AND u.mfa_enabled=true
  ) THEN RAISE EXCEPTION 'ownership target must be active with MFA'; END IF;
  UPDATE relay_tenant_ownership SET user_id=p_target,changed_by=p_source,changed_at=now()
   WHERE tenant_id=p_tenant;
  UPDATE relay_tenant_memberships SET role='owner',status='active',updated_at=now()
   WHERE tenant_id=p_tenant AND user_id=p_target;
  UPDATE relay_tenant_memberships SET role='admin',updated_at=now()
   WHERE tenant_id=p_tenant AND user_id=p_source;
  RETURN QUERY SELECT p_source,p_target;
END;
$$;

INSERT INTO relay_meta(key,value) VALUES ('schema_version','25')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
