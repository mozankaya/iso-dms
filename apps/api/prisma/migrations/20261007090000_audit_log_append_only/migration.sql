-- The audit trail is a record in the sense of ISO 9001 7.5.3: entries are only ever added. The database refuses
-- to change or delete them, so a bug or a careless query in the application cannot rewrite history.
-- Prisma does not know about triggers; this lives in SQL only (like Revision_one_open_per_document).
--
-- The one way around it is a transaction that sets app.audit_log_maintenance to 'on' (SET LOCAL). The
-- application never does that; tests use it to clean up the data they created, and so can an administrator
-- of the database for a deliberate, documented intervention.

CREATE FUNCTION audit_log_refuse_changes() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.audit_log_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
      RETURN NEW;
    END IF;
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'AuditLog entries cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_refuse_changes();

CREATE TRIGGER "AuditLog_no_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_refuse_changes();
