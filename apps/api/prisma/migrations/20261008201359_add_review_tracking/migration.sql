-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "defaultReviewIntervalMonths" INTEGER;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "lastReviewedAt" TIMESTAMP(3);
