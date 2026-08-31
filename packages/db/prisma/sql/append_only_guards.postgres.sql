-- Postgres equivalent of the SQLite append-only guards.
-- Kept in step with append_only_guards.sql so the MVP can graduate without
-- losing its protections.

CREATE OR REPLACE FUNCTION razortrust_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION razortrust_reject_mutation();

DROP TRIGGER IF EXISTS audit_checkpoints_append_only ON audit_checkpoints;
CREATE TRIGGER audit_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION razortrust_reject_mutation();

DROP TRIGGER IF EXISTS drift_checks_append_only ON drift_checks;
CREATE TRIGGER drift_checks_append_only
  BEFORE UPDATE OR DELETE ON drift_checks
  FOR EACH ROW EXECUTE FUNCTION razortrust_reject_mutation();

CREATE OR REPLACE FUNCTION razortrust_freeze_signed_mandate() RETURNS trigger AS $$
BEGIN
  IF OLD.signature IS NOT NULL AND (
    NEW."termsJson" IS DISTINCT FROM OLD."termsJson"
    OR NEW."termsHash" IS DISTINCT FROM OLD."termsHash"
    OR NEW.signature IS DISTINCT FROM OLD.signature
    OR NEW."signedByPublicKeyPem" IS DISTINCT FROM OLD."signedByPublicKeyPem"
  ) THEN
    RAISE EXCEPTION
      'Signed mandate terms are frozen: revoke this mandate and have the principal sign a new one';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mandates_terms_frozen ON mandates;
CREATE TRIGGER mandates_terms_frozen
  BEFORE UPDATE ON mandates
  FOR EACH ROW EXECUTE FUNCTION razortrust_freeze_signed_mandate();

-- Application role should not be able to drop its own guards.
-- REVOKE TRIGGER ON audit_events FROM razortrust_app;
