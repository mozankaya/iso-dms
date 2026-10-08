/**
 * One-off: indexes the text of every revision in force that is not searchable yet (PROJECT.md 6.16), such as the
 * documents published before full text search existed. The running API does the same at start-up and every ten
 * minutes; this only does it at once, without waiting. Safe to run again: documents that have a row are skipped.
 *
 * The service is built by hand: tsx does not emit the decorator metadata Nest needs to wire it up. It only uses
 * the two members of PrismaService and StorageService that the plain clients below also have.
 */
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

import { SearchIndexService } from '../src/modules/search/search-index.service';
import { ObjectStorage, objectStorageOptionsFromEnv } from '../src/modules/storage/object-storage';
import { createPrismaClient } from '../src/prisma/create-prisma-client';

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  try {
    const storage = new ObjectStorage(objectStorageOptionsFromEnv());
    const index = new SearchIndexService(prisma as never, storage as never);
    const looked = await index.sweep();
    console.log(`${looked} document(s) were not searchable yet; their text is indexed now.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
