-- CreateEnum
CREATE TYPE "SearchIndexStatus" AS ENUM ('INDEXED', 'SKIPPED');

-- CreateTable
CREATE TABLE "RevisionText" (
    "revisionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" "SearchIndexStatus" NOT NULL,
    "content" TEXT NOT NULL,
    "searchVector" tsvector,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevisionText_pkey" PRIMARY KEY ("revisionId")
);

-- CreateIndex
CREATE INDEX "RevisionText_organizationId_documentId_idx" ON "RevisionText"("organizationId", "documentId");

-- CreateIndex
CREATE INDEX "RevisionText_searchVector_idx" ON "RevisionText" USING GIN ("searchVector");

-- AddForeignKey
ALTER TABLE "RevisionText" ADD CONSTRAINT "RevisionText_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "Revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevisionText" ADD CONSTRAINT "RevisionText_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
