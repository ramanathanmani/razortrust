-- Append-only guards for the audit tables (SQLite).
--
-- These are the second line of defence, not the first. The hash chain and the
-- signed checkpoints are what make tampering DETECTABLE; these triggers make
-- the ordinary path — an application bug, a careless script, an ORM cascade —
-- fail loudly instead of quietly rewriting history.
--
-- Applied by `npm run guards -w @razortrust/db`, after every db push.
-- Postgres equivalent lives in append_only_guards.postgres.sql.

DROP TRIGGER IF EXISTS audit_events_no_update;
DROP TRIGGER IF EXISTS audit_events_no_delete;
DROP TRIGGER IF EXISTS audit_checkpoints_no_update;
DROP TRIGGER IF EXISTS audit_checkpoints_no_delete;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: DELETE is not permitted');
END;

CREATE TRIGGER audit_checkpoints_no_update
BEFORE UPDATE ON audit_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'audit_checkpoints is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER audit_checkpoints_no_delete
BEFORE DELETE ON audit_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'audit_checkpoints is append-only: DELETE is not permitted');
END;

-- Drift checks are evidence too: a re-evaluation writes a NEW row rather than
-- editing the old verdict, so the sequence of decisions stays readable.
DROP TRIGGER IF EXISTS drift_checks_no_update;
DROP TRIGGER IF EXISTS drift_checks_no_delete;

CREATE TRIGGER drift_checks_no_update
BEFORE UPDATE ON drift_checks
BEGIN
  SELECT RAISE(ABORT, 'drift_checks is append-only: record a new evaluation instead');
END;

CREATE TRIGGER drift_checks_no_delete
BEFORE DELETE ON drift_checks
BEGIN
  SELECT RAISE(ABORT, 'drift_checks is append-only: DELETE is not permitted');
END;

-- A signed mandate is a document, not a record. Revocation and consumption
-- counters are mutable; the signed material is not.
DROP TRIGGER IF EXISTS mandates_terms_frozen;

CREATE TRIGGER mandates_terms_frozen
BEFORE UPDATE ON mandates
WHEN OLD.signature IS NOT NULL
  AND (
    NEW.termsJson IS NOT OLD.termsJson
    OR NEW.termsHash IS NOT OLD.termsHash
    OR NEW.signature IS NOT OLD.signature
    OR NEW.signedByPublicKeyPem IS NOT OLD.signedByPublicKeyPem
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'Signed mandate terms are frozen: revoke this mandate and have the principal sign a new one'
  );
END;
