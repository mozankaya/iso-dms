/**
 * Checks that every file the database knows of is in the storage with the right SHA-256, and that the database
 * guards (audit trail, feedback) are in place (PROJECT.md 11.2). Read only.
 *
 *   pnpm --filter @iso-dms/api storage:verify            human readable
 *   pnpm --filter @iso-dms/api storage:verify --json     the report as JSON (what ops/backup.sh and the restore drill read)
 *   pnpm --filter @iso-dms/api storage:verify --counts   only the row counts, as JSON
 *
 * Exit code 1 when anything is wrong. Built by hand like the other scripts (tsx emits no decorator metadata).
 */
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

import { collectCounts, verifyStorageIntegrity } from '../src/ops/storage-integrity';
import { ObjectStorage, objectStorageOptionsFromEnv } from '../src/modules/storage/object-storage';
import { createPrismaClient } from '../src/prisma/create-prisma-client';

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const prisma = createPrismaClient();
  try {
    if (flags.has('--counts')) {
      console.log(JSON.stringify(await collectCounts(prisma)));
      return;
    }

    const report = await verifyStorageIntegrity(prisma, new ObjectStorage(objectStorageOptionsFromEnv()));
    if (flags.has('--json')) {
      console.log(JSON.stringify(report));
    } else {
      const { checked, problems, guards, counts } = report;
      console.log(`Checked ${checked.revisionFiles} revision file(s), ${checked.pdfCopies} PDF copy(ies), ${checked.templateFiles} template file(s).`);
      console.log(`Rows: ${Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(', ')}.`);
      console.log(`Database guards: audit trail ${guards.auditLogAppendOnly && guards.auditLogNoTruncate ? 'protected' : 'NOT PROTECTED'}, feedback ${guards.feedbackProtected ? 'protected' : 'NOT PROTECTED'}.`);
      for (const problem of problems) console.log(`${problem.problem}: ${problem.kind} ${problem.id} (${problem.storageKey})`);
      console.log(report.ok ? 'OK: everything is in place.' : `PROBLEMS FOUND: ${problems.length} file problem(s) or a missing guard.`);
    }
    if (!report.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
