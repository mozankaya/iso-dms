import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

// Tests never touch the real document bucket
process.env.S3_BUCKET = process.env.S3_TEST_BUCKET ?? 'documents-test';

// Tests run without the PDF queue (no Redis needed); the specs about PDF copies switch it on for themselves
process.env.JOBS_ENABLED = 'false';
process.env.REDIS_QUEUE_PREFIX = 'iso-dms-test';
// Mail is kept in memory (MailService.outbox) instead of being sent
process.env.MAIL_MODE = 'memory';
delete process.env.SMTP_HOST;
