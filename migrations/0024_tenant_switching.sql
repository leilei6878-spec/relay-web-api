ALTER TABLE relay_saas_sessions
  DROP CONSTRAINT IF EXISTS relay_saas_sessions_revoked_reason_check;
ALTER TABLE relay_saas_sessions
  ADD CONSTRAINT relay_saas_sessions_revoked_reason_check CHECK (
    revoked_reason IS NULL OR revoked_reason IN (
      'logout','password_reset','password_change','tenant_closed','tenant_switch',
      'user_revoke','user_revoke_others','mfa_recovery_rotation','mfa_reenrollment'
    )
  );

INSERT INTO relay_meta(key,value) VALUES ('schema_version','24')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();
