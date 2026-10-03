import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

// Tests never touch the real document bucket
process.env.S3_BUCKET = process.env.S3_TEST_BUCKET ?? 'documents-test';
