/**
 * One-off: asks for the PDF copy of every revision that was put in force before copies existed (PROJECT.md 6.12).
 * It only marks them as waiting; the running API picks them up (at start-up, or within ten minutes) and makes
 * the copies one at a time. Safe to run again: revisions that have a copy or are already waiting are left alone.
 */
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

import { createPrismaClient } from '../src/prisma/create-prisma-client';

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  try {
    const { count } = await prisma.revision.updateMany({
      where: { publishedAt: { not: null }, pdfStatus: 'NONE' },
      data: { pdfStatus: 'PENDING' },
    });
    console.log(`${count} revision(s) marked as waiting for their PDF copy.`);
    if (count > 0) console.log('The running API makes them within ten minutes (or restart it to start at once).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
