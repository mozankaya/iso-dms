-- CreateEnum
CREATE TYPE "PdfStatus" AS ENUM ('NONE', 'PENDING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "Revision" ADD COLUMN     "pdfChecksum" TEXT,
ADD COLUMN     "pdfFailureReason" TEXT,
ADD COLUMN     "pdfGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "pdfStatus" "PdfStatus" NOT NULL DEFAULT 'NONE';
