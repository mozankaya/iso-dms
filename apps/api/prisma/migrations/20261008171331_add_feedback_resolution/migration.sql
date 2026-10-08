-- DropIndex
DROP INDEX "Feedback_organizationId_isResolved_idx";

-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN     "resolutionNote" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT,
ADD COLUMN     "revisionId" TEXT;

-- CreateIndex
CREATE INDEX "Feedback_organizationId_isResolved_createdAt_idx" ON "Feedback"("organizationId", "isResolved", "createdAt");

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "Revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Feedback is a record like the audit trail (ISO 9001 7.5.3): what was sent can be closed and reopened, but the message,
-- its author, its document and its time are never changed, and a feedback is never deleted. Like the audit trail,
-- the only way around it is a transaction that sets app.audit_log_maintenance to 'on' (see audit_log_append_only).
CREATE FUNCTION feedback_protect_record() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.audit_log_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Feedback cannot be deleted';
  END IF;
  IF NEW."message" IS DISTINCT FROM OLD."message"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
    OR NEW."revisionId" IS DISTINCT FROM OLD."revisionId"
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'The content of a feedback cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Feedback_protect_record"
  BEFORE UPDATE OR DELETE ON "Feedback"
  FOR EACH ROW EXECUTE FUNCTION feedback_protect_record();
