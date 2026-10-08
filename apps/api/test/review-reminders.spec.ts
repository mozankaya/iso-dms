process.env.LOGIN_RATE_LIMIT = '1000';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import type { DocumentStatus, UserRole } from '../src/generated/prisma/enums';
import { MailService } from '../src/modules/notifications/mail.service';
import { ESCALATION_AFTER_DAYS, reminderMoment } from '../src/modules/review-reminders/review-reminder-stage';
import { ReviewReminderService } from '../src/modules/review-reminders/review-reminder.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { createTestApp } from './helpers/create-test-app';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 08:00 in Istanbul, when the job runs */
const NOW = new Date('2026-10-08T05:00:00.000Z');
const inDays = (days: number, from = NOW) => new Date(from.getTime() + days * DAY_MS);

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];

let app: INestApplication;
let reminders: ReviewReminderService;
let mail: MailService;
const org = {} as { id: string; deptA: string; deptB: string; category: string; foreignDocumentOwner: string };
type Label = 'owner' | 'goneOwner' | 'approverA' | 'approverB' | 'qm' | 'admin' | 'reader' | 'foreign' | 'inactiveQm';
const users = {} as Record<Label, { id: string; email: string }>;
let counter = 0;

const notificationsOf = (userId: string) => prisma.notification.findMany({ where: { userId, type: 'REVIEW_DUE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const forDocument = async (userId: string, code: string) => (await notificationsOf(userId)).filter((row) => row.title.includes(code));

async function createDocument(options: { nextReviewAt: Date | null; status?: DocumentStatus; owner?: Label; departmentId?: string; title?: string }) {
  const sequenceNo = 100 + counter++;
  const document = await prisma.document.create({
    data: {
      organizationId: org.id, categoryId: org.category, departmentId: options.departmentId ?? org.deptA, ownerId: users[options.owner ?? 'owner'].id,
      code: `RM-AA-${sequenceNo}`, sequenceNo, title: options.title ?? 'Hatırlatma denemesi', fileType: 'DOCX', status: options.status ?? 'PUBLISHED',
      reviewIntervalMonths: 12, nextReviewAt: options.nextReviewAt,
    },
  });
  return { id: document.id, code: document.code };
}

beforeAll(async () => {
  app = await createTestApp();
  reminders = app.get(ReviewReminderService);
  mail = app.get(MailService);

  const organization = await prisma.organization.create({ data: { name: `Remind ${suffix}`, slug: `remind-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `remind-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'RM' } })).id;

  const make = async (label: Label, role: UserRole, departmentId: string | null, isActive = true, organizationId = organization.id) => {
    const email = `${label}@remind.local`;
    const user = await prisma.user.create({ data: { organizationId, departmentId, email, fullName: `Kişi ${label}`, passwordHash: 'x', role, isActive } });
    users[label] = { id: user.id, email };
  };
  await make('owner', 'EDITOR', org.deptA);
  await make('goneOwner', 'EDITOR', org.deptA, false);
  await make('approverA', 'APPROVER', org.deptA);
  await make('approverB', 'APPROVER', org.deptB);
  await make('qm', 'QUALITY_MANAGER', org.deptA);
  await make('inactiveQm', 'QUALITY_MANAGER', org.deptA, false);
  await make('admin', 'ADMIN', org.deptA);
  await make('reader', 'READER', org.deptA);
  await make('foreign', 'QUALITY_MANAGER', null, true, foreign.id);

  // A document of another organization that is overdue: its people are told, ours are not
  const foreignDepartment = await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FF' } });
  await prisma.document.create({
    data: {
      organizationId: foreign.id, categoryId: foreignCategory.id, departmentId: foreignDepartment.id, ownerId: users.foreign.id, code: 'FF-FF-001', sequenceNo: 1,
      title: 'Yabancı', fileType: 'DOCX', status: 'PUBLISHED', reviewIntervalMonths: 12, nextReviewAt: inDays(-30),
    },
  });
});

beforeEach(() => {
  mail.outbox.length = 0;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
});

describe('which reminder a document is at', () => {
  const at = (daysUntil: number) => reminderMoment(inDays(daysUntil), NOW);

  it.each([
    [45, null],
    [30.5, null],
    [30, { stage: 'IN_30_DAYS', key: 'D30', overdueDays: 0 }],
    [8, { stage: 'IN_30_DAYS', key: 'D30', overdueDays: 0 }],
    [7, { stage: 'IN_7_DAYS', key: 'D7', overdueDays: 0 }],
    [0.5, { stage: 'IN_7_DAYS', key: 'D7', overdueDays: 0 }],
    [0, { stage: 'DUE', key: 'W0', overdueDays: 0 }],
    [-3, { stage: 'DUE', key: 'W0', overdueDays: 3 }],
    [-6.9, { stage: 'DUE', key: 'W0', overdueDays: 6 }],
    [-7, { stage: 'OVERDUE', key: 'W1', overdueDays: 7 }],
    [-13, { stage: 'OVERDUE', key: 'W1', overdueDays: 13 }],
    [-14, { stage: 'OVERDUE', key: 'W2', overdueDays: 14 }],
    [-100, { stage: 'OVERDUE', key: 'W14', overdueDays: 100 }],
  ])('%p days away: %j', (days, expected) => {
    expect(at(days as number)).toEqual(expected);
  });

  it('escalates after a week', () => {
    expect(ESCALATION_AFTER_DAYS).toBe(7);
  });
});

describe('the reminders to the one responsible', () => {
  it('says what is near, and links to the document', async () => {
    const doc = await createDocument({ nextReviewAt: inDays(20), title: 'Hatırlatma ilk' });

    await reminders.run(NOW);

    const [row] = await forDocument(users.owner.id, doc.code);
    expect(row).toMatchObject({ type: 'REVIEW_DUE', link: `/documents/${doc.id}`, organizationId: org.id, readAt: null });
    expect(row.title).toBe(`Gözden geçirme tarihi yaklaşıyor: ${doc.code}`);
    expect(row.body).toBe(`${doc.code} Hatırlatma ilk dokümanının gözden geçirme tarihi 28.10.2026 (30 gün içinde). Sorumlu: Kişi owner.`);
  });

  it('writes the date as it is in Istanbul', async () => {
    // 21:30 UTC is already the next day there
    const doc = await createDocument({ nextReviewAt: new Date('2026-10-17T21:30:00.000Z') });
    await reminders.run(NOW);
    const [row] = await forDocument(users.owner.id, doc.code);
    expect(row.body).toContain('18.10.2026');
  });

  it('sends each stage once, whatever the number of runs, and the next stage when its time comes', async () => {
    const doc = await createDocument({ nextReviewAt: inDays(20) });

    await reminders.run(NOW);
    await reminders.run(NOW);
    await reminders.run(inDays(1));
    expect(await forDocument(users.owner.id, doc.code)).toHaveLength(1);

    await reminders.run(inDays(14)); // 6 days left
    await reminders.run(inDays(15));
    expect((await forDocument(users.owner.id, doc.code)).map((row) => row.title)).toEqual([
      `Gözden geçirme tarihi yaklaşıyor: ${doc.code}`,
      `Gözden geçirme tarihi bir haftadan az: ${doc.code}`,
    ]);

    await reminders.run(inDays(20)); // the due day
    await reminders.run(inDays(23));
    const due = await forDocument(users.owner.id, doc.code);
    expect(due).toHaveLength(3);
    expect(due[2].title).toBe(`Gözden geçirme zamanı geldi: ${doc.code}`);

    await reminders.run(inDays(27)); // a week overdue
    await reminders.run(inDays(33));
    await reminders.run(inDays(34)); // two weeks
    const all = await forDocument(users.owner.id, doc.code);
    expect(all.map((row) => row.title).slice(3)).toEqual([`Gözden geçirme gecikti: ${doc.code}`, `Gözden geçirme gecikti: ${doc.code}`]);
    expect(all[3].body).toContain('geçti (7 gün)');
    expect(all[4].body).toContain('geçti (14 gün)');
  });

  it('starts again after the document was reviewed, since the date is new', async () => {
    const doc = await createDocument({ nextReviewAt: inDays(5) });
    await reminders.run(NOW);
    expect(await forDocument(users.owner.id, doc.code)).toHaveLength(1);

    await prisma.document.update({ where: { id: doc.id }, data: { nextReviewAt: inDays(10) } });
    await reminders.run(NOW);

    expect(await forDocument(users.owner.id, doc.code)).toHaveLength(2);
  });

  it('leaves out documents further away, without a date, and not in force', async () => {
    const far = await createDocument({ nextReviewAt: inDays(31) });
    const none = await createDocument({ nextReviewAt: null });
    const draft = await createDocument({ nextReviewAt: inDays(-3), status: 'DRAFT' });
    const withdrawn = await createDocument({ nextReviewAt: inDays(-3), status: 'WITHDRAWN' });
    const inReview = await createDocument({ nextReviewAt: inDays(-3), status: 'IN_REVIEW' });

    await reminders.run(NOW);

    for (const doc of [far, none, draft, withdrawn, inReview]) expect(await forDocument(users.owner.id, doc.code)).toHaveLength(0);
  });

  it('counts the documents it looked at and the messages it wrote, and writes none the second time', async () => {
    await createDocument({ nextReviewAt: inDays(3) });
    await createDocument({ nextReviewAt: inDays(-1) });

    const first = await reminders.run(NOW);
    const second = await reminders.run(NOW);

    expect(first.documents).toBeGreaterThanOrEqual(2);
    expect(first.notifications).toBeGreaterThanOrEqual(2);
    expect(second.documents).toBe(first.documents);
    expect(second.notifications).toBe(0);
  });

  it('tells the owner by e-mail too, once', async () => {
    const doc = await createDocument({ nextReviewAt: inDays(2) });

    await reminders.run(NOW);
    await reminders.run(NOW);

    const mails = mail.outbox.filter((message) => message.subject.includes(doc.code));
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(users.owner.email);
    expect(mails[0].text).toContain('Sorumlu: Kişi owner');
    expect(mails[0].text).toMatch(/https?:\/\/[^\s]+\/documents\//);
  });

  it('writes to nobody of another organization, and writes to the owner of that organization\'s own document', async () => {
    await reminders.run(NOW);

    const foreignRows = (await notificationsOf(users.foreign.id)).filter((row) => row.title.includes('FF-FF-001'));
    expect(foreignRows.length).toBeGreaterThan(0);
    for (const label of ['owner', 'approverA', 'qm', 'admin'] as const) {
      expect((await notificationsOf(users[label].id)).some((row) => row.title.includes('FF-FF-001'))).toBe(false);
    }
  });
});

describe('when it has been overdue for long, or the owner cannot be told', () => {
  it('tells the approvers of the department and the quality managers once it is more than a week late, not before', async () => {
    const doc = await createDocument({ nextReviewAt: inDays(-7) });
    await reminders.run(NOW); // exactly a week: still only the owner
    expect((await forDocument(users.owner.id, doc.code)).length).toBe(1);
    for (const label of ['approverA', 'qm'] as const) expect(await forDocument(users[label].id, doc.code)).toHaveLength(0);

    await reminders.run(inDays(1)); // more than a week

    for (const label of ['approverA', 'qm'] as const) {
      const [row] = await forDocument(users[label].id, doc.code);
      expect(row.title).toBe(`Gözden geçirme gecikti: ${doc.code}`);
    }
    // The owner already had this stage's message
    expect(await forDocument(users.owner.id, doc.code)).toHaveLength(1);
  });

  it('does not tell approvers of other departments, administrators, readers, inactive people or people of other organizations', async () => {
    const doc = await createDocument({ nextReviewAt: inDays(-20) });
    await reminders.run(NOW);

    for (const label of ['approverB', 'admin', 'reader', 'inactiveQm', 'foreign'] as const) expect(await forDocument(users[label].id, doc.code)).toHaveLength(0);
  });

  it('tells a person once even when they are the owner and an approver at the same time', async () => {
    const doc = await createDocument({ nextReviewAt: inDays(-20), owner: 'approverA' });
    await reminders.run(NOW);
    expect(await forDocument(users.approverA.id, doc.code)).toHaveLength(1);
  });

  it('turns to the approvers and quality managers at once when the owner is not active any more', async () => {
    const doc = await createDocument({ nextReviewAt: inDays(15), owner: 'goneOwner' });

    await reminders.run(NOW);

    expect(await forDocument(users.goneOwner.id, doc.code)).toHaveLength(0);
    for (const label of ['approverA', 'qm'] as const) expect(await forDocument(users[label].id, doc.code)).toHaveLength(1);
    expect(mail.outbox.some((message) => message.to === users.goneOwner.email)).toBe(false);
  });

  it('follows the department of the document, not that of the owner', async () => {
    const doc = await createDocument({ nextReviewAt: inDays(-30), departmentId: org.deptB });
    await reminders.run(NOW);

    expect(await forDocument(users.approverB.id, doc.code)).toHaveLength(1);
    expect(await forDocument(users.approverA.id, doc.code)).toHaveLength(0);
  });
});

describe('many documents', () => {
  it('goes through all of them, page after page', async () => {
    const owner = users.owner.id;
    const start = 5000;
    await prisma.document.createMany({
      data: Array.from({ length: 205 }, (_unused, index) => ({
        organizationId: org.id, categoryId: org.category, departmentId: org.deptA, ownerId: owner, code: `RM-AA-${start + index}`, sequenceNo: start + index,
        title: 'Toplu', fileType: 'DOCX' as const, status: 'PUBLISHED' as const, reviewIntervalMonths: 12, nextReviewAt: inDays(4),
      })),
    });

    const summary = await reminders.run(NOW);

    expect(summary.documents).toBeGreaterThanOrEqual(205);
    const rows = await prisma.notification.count({ where: { userId: owner, type: 'REVIEW_DUE', title: { contains: 'RM-AA-5' } } });
    expect(rows).toBe(205);
  });
});
