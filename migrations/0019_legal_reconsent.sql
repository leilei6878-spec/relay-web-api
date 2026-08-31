ALTER TABLE relay_legal_acceptances
  DROP CONSTRAINT IF EXISTS relay_legal_acceptances_acceptance_method_check;

ALTER TABLE relay_legal_acceptances
  ADD CONSTRAINT relay_legal_acceptances_acceptance_method_check
  CHECK (acceptance_method IN ('registration','invite','reconsent'));

INSERT INTO relay_meta(key,value) VALUES ('schema_version','19')
ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=now();

