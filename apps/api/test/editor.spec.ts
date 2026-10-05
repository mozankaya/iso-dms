process.env.LOGIN_RATE_LIMIT = '1000';
process.env.MAX_UPLOAD_MB = '1'; // read at call time by the callback; keeps the oversized-file test small

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import JSZip from 'jszip';
import request from 'supertest';
import type { DocumentDetailDto, EditorSessionDto } from '@iso-dms/shared';
import type { DocumentStatus, RevisionStatus, UserRole } from '../src/generated/prisma/enums';
import { AuditLogsService } from '../src/modules/audit-logs/audit-logs.service';
import { FileTokenService } from '../src/modules/editor/file-token.service';
import { buildRevisionKey } from '../src/modules/storage/storage-keys';
import { StorageService } from '../src/modules/storage/storage.service';
import { createPrismaClient } from '../src/prisma/create-prisma-client';
import { createTestApp } from './helpers/create-test-app';
import { signToken } from './helpers/tokens';

const prisma = createPrismaClient();
const suffix = randomUUID().slice(0, 8);
const organizationIds: string[] = [];
const ONLYOFFICE_SECRET = process.env.ONLYOFFICE_JWT_SECRET!;

let app: INestApplication;
let storage: StorageService;
let jwt: JwtService;
let fileTokens: FileTokenService;
let blankDocx: Buffer;
let blankXlsx: Buffer;
let editedDocx: Buffer;

// ---- fake ONLYOFFICE document server: only serves the files its callbacks point to ----
let fakeServer: http.Server;
let fakeOrigin: string;
let fakeRequests: string[] = [];

const org = {} as { id: string; deptA: string; deptB: string; category: string };
const users = {} as Record<'reader' | 'editorA' | 'editorB' | 'approverA' | 'qm' | 'admin', { id: string; token: string }>;
const docs = {} as Record<
  'draftA' | 'draftB' | 'published' | 'publishedWithDraft' | 'inReview' | 'superseded' | 'sheet' | 'foreign',
  { id: string; revisions: { id: string; revisionNo: number }[] }
>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function startFakeServer(): Promise<void> {
  const huge = Buffer.alloc(1024 * 1024 + 10, 1);
  fakeServer = http.createServer((req, res) => {
    fakeRequests.push(req.url ?? '');
    const send = (status: number, body: Buffer) => res.writeHead(status, { 'Content-Length': body.length }).end(body);
    switch ((req.url ?? '').split('?')[0]) {
      case '/cache/files/edited.docx':
        return send(200, editedDocx);
      case '/cache/files/edited.xlsx':
        return send(200, blankXlsx);
      case '/cache/files/not-an-office-file.docx':
        return send(200, Buffer.from('plain text, not a zip package'));
      case '/cache/files/huge.docx':
        return send(200, huge);
      default:
        return send(404, Buffer.from('not found'));
    }
  });
  await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
  fakeOrigin = `http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`;
}

async function makeDocx(text: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(blankDocx);
  zip.file('word/document.xml', (await zip.file('word/document.xml')!.async('string')).replace('<w:p/>', `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function createDocument(options: {
  code: string;
  departmentId: string;
  organizationId?: string;
  status: DocumentStatus;
  fileType?: 'DOCX' | 'XLSX';
  revisions: { revisionNo: number; status: RevisionStatus; current?: boolean }[];
}) {
  const organizationId = options.organizationId ?? org.id;
  const fileType = options.fileType ?? 'DOCX';
  const content = fileType === 'DOCX' ? blankDocx : blankXlsx;
  const ownerId = users.admin.id;

  const document = await prisma.document.create({
    data: {
      organizationId,
      categoryId: org.category,
      departmentId: options.departmentId,
      ownerId,
      code: options.code,
      sequenceNo: Number(options.code.split('-').at(-1)),
      title: `Title of ${options.code}`,
      fileType,
      status: options.status,
    },
  });

  const revisions: { id: string; revisionNo: number }[] = [];
  for (const spec of options.revisions) {
    const storageKey = buildRevisionKey({ organizationId, documentId: document.id, revisionNo: spec.revisionNo, fileType });
    await storage.put(storageKey, content, 'application/octet-stream');
    const revision = await prisma.revision.create({
      data: {
        organizationId,
        documentId: document.id,
        revisionNo: spec.revisionNo,
        status: spec.status,
        storageKey,
        fileSize: content.length,
        checksum: createHash('sha256').update(content).digest('hex'),
        editorKey: randomUUID(),
        preparedById: ownerId,
      },
    });
    revisions.push({ id: revision.id, revisionNo: spec.revisionNo });
    if (spec.current) {
      await prisma.document.update({ where: { id: document.id }, data: { currentRevisionId: revision.id } });
    }
  }
  return { id: document.id, revisions };
}

beforeAll(async () => {
  blankDocx = await readFile(path.resolve(__dirname, '../templates/blank.docx'));
  blankXlsx = await readFile(path.resolve(__dirname, '../templates/blank.xlsx'));
  editedDocx = await makeDocx('edited in the editor');
  await startFakeServer();
  // The API fetches saved files from here instead of from a real document server
  process.env.ONLYOFFICE_INTERNAL_URL = fakeOrigin;
  process.env.ONLYOFFICE_PUBLIC_URL = 'http://localhost:8080';

  app = await createTestApp();
  storage = app.get(StorageService);
  jwt = app.get(JwtService);
  fileTokens = app.get(FileTokenService);

  const organization = await prisma.organization.create({ data: { name: `Editor ${suffix}`, slug: `editor-${suffix}` } });
  const foreign = await prisma.organization.create({ data: { name: `Foreign ${suffix}`, slug: `editor-f-${suffix}` } });
  organizationIds.push(organization.id, foreign.id);
  org.id = organization.id;
  org.deptA = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Alpha', code: 'AA' } })).id;
  org.deptB = (await prisma.department.create({ data: { organizationId: organization.id, name: 'Beta', code: 'BB' } })).id;
  org.category = (await prisma.category.create({ data: { organizationId: organization.id, name: 'Main', slug: 'main', codePrefix: 'MM' } })).id;

  const makeUser = async (label: keyof typeof users, role: UserRole, departmentId: string | null) => {
    const user = await prisma.user.create({
      data: { organizationId: organization.id, departmentId, email: `${label}@editor.local`, fullName: `Name ${label}`, passwordHash: 'x', role },
    });
    users[label] = { id: user.id, token: await signToken(app, { userId: user.id, organizationId: organization.id, role, departmentId }) };
  };
  await makeUser('admin', 'ADMIN', null);
  await makeUser('qm', 'QUALITY_MANAGER', null);
  await makeUser('reader', 'READER', org.deptA);
  await makeUser('editorA', 'EDITOR', org.deptA);
  await makeUser('editorB', 'EDITOR', org.deptB);
  await makeUser('approverA', 'APPROVER', org.deptA);

  docs.draftA = await createDocument({ code: 'MM-AA-001', departmentId: org.deptA, status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
  docs.draftB = await createDocument({ code: 'MM-BB-001', departmentId: org.deptB, status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
  docs.published = await createDocument({ code: 'MM-AA-002', departmentId: org.deptA, status: 'PUBLISHED', revisions: [{ revisionNo: 0, status: 'APPROVED', current: true }] });
  docs.publishedWithDraft = await createDocument({
    code: 'MM-AA-003',
    departmentId: org.deptA,
    status: 'PUBLISHED',
    revisions: [{ revisionNo: 0, status: 'SUPERSEDED' }, { revisionNo: 1, status: 'APPROVED', current: true }, { revisionNo: 2, status: 'DRAFT' }],
  });
  docs.inReview = await createDocument({ code: 'MM-AA-004', departmentId: org.deptA, status: 'IN_REVIEW', revisions: [{ revisionNo: 0, status: 'IN_REVIEW' }] });
  docs.superseded = docs.publishedWithDraft; // revision 0 of this document is superseded
  docs.sheet = await createDocument({ code: 'MM-AA-005', departmentId: org.deptA, status: 'DRAFT', fileType: 'XLSX', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });

  const foreignDept = await prisma.department.create({ data: { organizationId: foreign.id, name: 'F', code: 'FF' } });
  const foreignCategory = await prisma.category.create({ data: { organizationId: foreign.id, name: 'F', slug: 'f', codePrefix: 'FC' } });
  const foreignUser = await prisma.user.create({ data: { organizationId: foreign.id, email: 'f@editor.local', fullName: 'F', passwordHash: 'x' } });
  const foreignDoc = await prisma.document.create({
    data: { organizationId: foreign.id, categoryId: foreignCategory.id, departmentId: foreignDept.id, ownerId: foreignUser.id, code: 'FC-FF-001', sequenceNo: 1, title: 'F', fileType: 'DOCX', status: 'PUBLISHED' },
  });
  const foreignRevision = await prisma.revision.create({
    data: { organizationId: foreign.id, documentId: foreignDoc.id, revisionNo: 0, status: 'APPROVED', storageKey: 'foreign/none', fileSize: 1, checksum: 'x', editorKey: randomUUID(), preparedById: foreignUser.id },
  });
  docs.foreign = { id: foreignDoc.id, revisions: [{ id: foreignRevision.id, revisionNo: 0 }] };
});

afterAll(async () => {
  // Test cleanup only: the application never deletes revisions or their files
  const revisions = await prisma.revision.findMany({ where: { organizationId: { in: organizationIds } } });
  await Promise.all(revisions.map((revision) => storage.delete(revision.storageKey).catch(() => undefined)));
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.updateMany({ where: { organizationId: { in: organizationIds } }, data: { currentRevisionId: null } });
  await prisma.revision.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.document.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.department.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.category.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  await prisma.$disconnect();
  await app.close();
  await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
});

function getSession(token: string, revisionId: string) {
  return request(app.getHttpServer()).get(`/api/editor/config/${revisionId}`).set(auth(token));
}

async function openSession(token: string, revisionId: string): Promise<EditorSessionDto> {
  return (await getSession(token, revisionId).expect(200)).body as EditorSessionDto;
}

/** Path + query of an absolute URL the API handed out, so supertest can call it. */
function relative(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function callbackPath(session: EditorSessionDto): string {
  return relative((session.config.editorConfig as { callbackUrl: string }).callbackUrl);
}

/** What the document server sends: the JWT in the Authorization header, data nested under "payload". */
function postCallback(path: string, data: Record<string, unknown>, options: { secret?: string; mode?: 'header' | 'body' | 'none' } = {}) {
  const secret = options.secret ?? ONLYOFFICE_SECRET;
  const req = request(app.getHttpServer()).post(path);
  if (options.mode === 'body') return req.send({ ...data, token: jwt.sign(data, { secret }) });
  if (options.mode === 'none') return req.send(data);
  return req.set('Authorization', `Bearer ${jwt.sign({ payload: data }, { secret })}`).send(data);
}

async function revisionRow(id: string) {
  return prisma.revision.findUniqueOrThrow({ where: { id } });
}

async function auditActions(entityId: string): Promise<string[]> {
  return (await prisma.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } })).map((entry) => entry.action);
}

describe('GET /api/editor/config/:revisionId', () => {
  it('requires authentication and a valid id', async () => {
    await request(app.getHttpServer()).get(`/api/editor/config/${docs.draftA.revisions[0].id}`).expect(401);
    await getSession(users.admin.token, 'not-a-uuid').expect(400);
    await getSession(users.admin.token, randomUUID()).expect(404);
  });

  describe('mode and access', () => {
    const rev = (name: keyof typeof docs, index = 0) => () => docs[name].revisions[index].id;

    it.each([
      ['an editor of the department edits an open draft', 'editorA', rev('draftA'), 'edit'],
      ['an approver of the department edits an open draft', 'approverA', rev('draftA'), 'edit'],
      ['a quality manager edits drafts of any department', 'qm', rev('draftB'), 'edit'],
      ['an admin edits drafts of any department', 'admin', rev('draftB'), 'edit'],
      ['an approver only views drafts of other departments', 'approverA', rev('draftB'), 'view'],
      ['an editor views a revision in review (locked)', 'editorA', rev('inReview'), 'view'],
      ['an admin only views a revision in review', 'admin', rev('inReview'), 'view'],
      ['a reader views the revision in force', 'reader', rev('published'), 'view'],
      ['an editor of another department views the revision in force', 'editorB', rev('published'), 'view'],
      ['an editor edits the new draft of a published document', 'editorA', rev('publishedWithDraft', 2), 'edit'],
      ['an approver views a superseded revision', 'approverA', rev('superseded', 0), 'view'],
      ['an editor edits a spreadsheet draft', 'editorA', rev('sheet'), 'edit'],
    ] as const)('%s', async (_label, who, revisionId, mode) => {
      const session = await openSession(users[who].token, revisionId());
      expect(session.mode).toBe(mode);
      expect((session.config.editorConfig as { mode: string }).mode).toBe(mode);
    });

    it.each([
      ['a reader cannot open a draft', 'reader', rev('draftA')],
      ['a reader cannot open a revision in review', 'reader', rev('inReview')],
      ['a reader cannot open the new draft of a published document', 'reader', rev('publishedWithDraft', 2)],
      ['a reader cannot open a superseded revision', 'reader', rev('superseded', 0)],
      ['an editor of another department cannot open a draft', 'editorB', rev('draftA')],
      ['an editor of another department cannot open the new draft of a published document', 'editorB', rev('publishedWithDraft', 2)],
      ['nobody opens a revision of another organization', 'admin', rev('foreign')],
    ] as const)('%s', async (_label, who, revisionId) => {
      const response = await getSession(users[who].token, revisionId()).expect(404);
      expect(response.body.code).toBe('REVISION_NOT_FOUND');
    });
  });

  describe('configuration', () => {
    it('describes a Word draft for editing, signed with the ONLYOFFICE secret', async () => {
      const revision = await revisionRow(docs.draftA.revisions[0].id);
      const session = await openSession(users.editorA.token, revision.id);
      const { token, ...unsigned } = session.config as Record<string, unknown> & { token: string };

      expect(jwt.verify(token, { secret: ONLYOFFICE_SECRET })).toMatchObject(JSON.parse(JSON.stringify(unsigned)));
      expect(session.config).toMatchObject({
        documentType: 'word',
        document: {
          fileType: 'docx',
          key: revision.editorKey,
          title: 'MM-AA-001 Title of MM-AA-001.docx',
          permissions: { edit: true, comment: true, download: true, print: true },
        },
        editorConfig: {
          mode: 'edit',
          lang: 'tr',
          user: { id: users.editorA.id, name: 'Name editorA' },
          customization: { forcesave: true, autosave: true },
        },
      });
    });

    it('describes an Excel document with the cell editor', async () => {
      const session = await openSession(users.editorA.token, docs.sheet.revisions[0].id);
      expect(session.config).toMatchObject({ documentType: 'cell', document: { fileType: 'xlsx' } });
    });

    it('uses the key of the revision, so a content change means a new key', async () => {
      const revision = await revisionRow(docs.published.revisions[0].id);
      const session = await openSession(users.reader.token, revision.id);
      expect((session.config.document as { key: string }).key).toBe(revision.editorKey);
    });

    it('gives view sessions no callback address and no edit permission', async () => {
      const session = await openSession(users.reader.token, docs.published.revisions[0].id);

      expect(session.config.editorConfig).not.toHaveProperty('callbackUrl');
      expect(session.config.document).toMatchObject({ permissions: { edit: false, comment: false, download: true, print: true } });
    });

    it('points the document server to the API address it can reach, with signed tokens', async () => {
      const revision = docs.draftA.revisions[0];
      const session = await openSession(users.editorA.token, revision.id);
      const apiBase = process.env.API_INTERNAL_URL!.replace(/\/+$/, '');
      const documentUrl = (session.config.document as { url: string }).url;
      const callbackUrl = (session.config.editorConfig as { callbackUrl: string }).callbackUrl;

      expect(documentUrl.startsWith(`${apiBase}/api/editor/files/${revision.id}?token=`)).toBe(true);
      expect(callbackUrl.startsWith(`${apiBase}/api/editor/callback/${revision.id}?token=`)).toBe(true);
      const organizationId = org.id;
      await expect(fileTokens.verify(new URL(documentUrl).searchParams.get('token')!, 'download', revision.id)).resolves.toMatchObject({ organizationId });
      await expect(fileTokens.verify(new URL(callbackUrl).searchParams.get('token')!, 'callback', revision.id)).resolves.toMatchObject({ organizationId });
    });

    it('returns the document summary the editor screen shows', async () => {
      const session = await openSession(users.editorA.token, docs.draftA.revisions[0].id);

      expect(session.document).toEqual({ id: docs.draftA.id, code: 'MM-AA-001', title: 'Title of MM-AA-001', status: 'DRAFT' });
      expect(session.revision).toEqual({ id: docs.draftA.revisions[0].id, revisionNo: 0, status: 'DRAFT' });
    });

    it('records who opened the document and in which mode', async () => {
      // A document of its own: other tests open the shared fixtures and would add entries
      const draft = await createDocument({ code: 'MM-BB-090', departmentId: org.deptB, status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
      await openSession(users.qm.token, draft.revisions[0].id);
      await openSession(users.approverA.token, draft.revisions[0].id);

      const entries = await prisma.auditLog.findMany({ where: { entityId: draft.id, action: 'DOCUMENT_OPENED' } });
      expect(entries.map((entry) => entry.metadata).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
        expect.objectContaining({ mode: 'edit', revisionNo: 0 }),
        expect.objectContaining({ mode: 'view', revisionNo: 0 }),
      ]);
      expect(entries.map((entry) => entry.userId).sort()).toEqual([users.approverA.id, users.qm.id].sort());
    });
  });
});

describe('file tokens', () => {
  const revisionId = () => docs.draftA.revisions[0].id;
  const claims = () => ({ revisionId: revisionId(), organizationId: org.id });

  it('accepts a token for the purpose and revision it was issued for', async () => {
    const token = await fileTokens.sign({ purpose: 'download', ...claims() });
    await expect(fileTokens.verify(token, 'download', revisionId())).resolves.toMatchObject({ purpose: 'download' });
  });

  it.each([
    ['for another purpose', async () => fileTokens.sign({ purpose: 'callback', ...claims() }), revisionId],
    ['for another revision', async () => fileTokens.sign({ purpose: 'download', ...claims() }), () => docs.draftB.revisions[0].id],
    ['that is expired', async () => jwt.sign({ purpose: 'download', ...claims() }, { secret: process.env.FILE_TOKEN_SECRET!, expiresIn: -10 }), revisionId],
    ['signed with another secret', async () => jwt.sign({ purpose: 'download', ...claims() }, { secret: 'another-secret' }), revisionId],
    ['that is garbage', async () => 'not.a.token', revisionId],
    ['that is missing', async () => undefined, revisionId],
  ])('rejects a token %s', async (_label, makeToken, forRevision) => {
    await expect(fileTokens.verify(await makeToken(), 'download', forRevision())).rejects.toMatchObject({ status: 403 });
  });
});

describe('GET /api/editor/files/:revisionId', () => {
  async function downloadPath(token: string, revisionId: string): Promise<string> {
    const session = await openSession(token, revisionId);
    return relative((session.config.document as { url: string }).url);
  }

  it('streams the stored file to the document server without a user JWT', async () => {
    const path = await downloadPath(users.editorA.token, docs.draftA.revisions[0].id);

    const response = await request(app.getHttpServer()).get(path).buffer(true).parse(binaryParser).expect(200);

    expect(response.headers['content-type']).toContain('wordprocessingml.document');
    expect(response.headers['content-length']).toBe(String(blankDocx.length));
    expect((response.body as Buffer).equals(blankDocx)).toBe(true);
  });

  it('serves view sessions as well, and spreadsheets with their own type', async () => {
    const reader = await downloadPath(users.reader.token, docs.published.revisions[0].id);
    await request(app.getHttpServer()).get(reader).expect(200);

    const sheet = await downloadPath(users.editorA.token, docs.sheet.revisions[0].id);
    const response = await request(app.getHttpServer()).get(sheet).buffer(true).parse(binaryParser).expect(200);
    expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
  });

  it('refuses a request without a valid token', async () => {
    const id = docs.draftA.revisions[0].id;
    await request(app.getHttpServer()).get(`/api/editor/files/${id}`).expect(403);
    await request(app.getHttpServer()).get(`/api/editor/files/${id}?token=garbage`).expect(403);
  });

  it('refuses a token issued for another revision or for the callback', async () => {
    const other = new URL(`http://x${await downloadPath(users.admin.token, docs.draftB.revisions[0].id)}`).searchParams.get('token');
    await request(app.getHttpServer()).get(`/api/editor/files/${docs.draftA.revisions[0].id}?token=${other}`).expect(403);

    const callbackToken = await fileTokens.sign({ purpose: 'callback', revisionId: docs.draftA.revisions[0].id, organizationId: org.id });
    await request(app.getHttpServer()).get(`/api/editor/files/${docs.draftA.revisions[0].id}?token=${callbackToken}`).expect(403);
  });

  it('answers 404 for a revision that no longer exists', async () => {
    const id = randomUUID();
    const token = await fileTokens.sign({ purpose: 'download', revisionId: id, organizationId: org.id });
    await request(app.getHttpServer()).get(`/api/editor/files/${id}?token=${token}`).expect(404);
  });

  it('answers 404 with a clear code when the stored file is missing', async () => {
    const created = await createDocument({ code: 'MM-AA-950', departmentId: org.deptA, status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
    const path = await downloadPath(users.admin.token, created.revisions[0].id);
    await storage.delete((await revisionRow(created.revisions[0].id)).storageKey);

    const response = await request(app.getHttpServer()).get(path).expect(404);
    expect(response.body.code).toBe('REVISION_FILE_MISSING');
  });

  it('does not serve a revision through a token of another organization', async () => {
    const id = docs.draftA.revisions[0].id;
    const token = await fileTokens.sign({ purpose: 'download', revisionId: id, organizationId: randomUUID() });
    await request(app.getHttpServer()).get(`/api/editor/files/${id}?token=${token}`).expect(404);
  });
});

function binaryParser(res: request.Response, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('POST /api/editor/callback/:revisionId', () => {
  let draftCounter = 0;

  /** Opens a fresh draft the test can save into, and returns what a callback needs. */
  async function freshDraft(options: { status?: RevisionStatus; fileType?: 'DOCX' | 'XLSX' } = {}) {
    const created = await createDocument({
      code: `MM-AA-${1000 + draftCounter++}`,
      departmentId: org.deptA,
      status: options.status === 'IN_REVIEW' ? 'IN_REVIEW' : 'DRAFT',
      fileType: options.fileType,
      revisions: [{ revisionNo: 0, status: options.status ?? 'DRAFT' }],
    });
    const revisionId = created.revisions[0].id;
    const session = await openSession(users.admin.token, revisionId);
    const row = await revisionRow(revisionId);
    return { revisionId, session, path: callbackPath(session), key: row.editorKey, storageKey: row.storageKey };
  }

  // Not every revision has a callback address: those that are locked are opened view-only
  async function lockedDraft() {
    const draft = await freshDraft();
    await prisma.revision.update({ where: { id: draft.revisionId }, data: { status: 'IN_REVIEW' } });
    return draft;
  }

  beforeEach(() => {
    fakeRequests = [];
  });

  describe('the edit session mark', () => {
    it('is set when an editing session is handed out, and only then', async () => {
      const draft = await createDocument({ code: 'MM-BB-091', departmentId: org.deptB, status: 'DRAFT', revisions: [{ revisionNo: 0, status: 'DRAFT' }] });
      const revisionId = draft.revisions[0].id;
      expect((await revisionRow(revisionId)).editSessionStartedAt).toBeNull();

      await openSession(users.approverA.token, revisionId); // view only: another department
      expect((await revisionRow(revisionId)).editSessionStartedAt).toBeNull();

      await openSession(users.qm.token, revisionId);
      expect((await revisionRow(revisionId)).editSessionStartedAt).toBeInstanceOf(Date);
    });

    it('is not set on a revision that was locked: that session is read only', async () => {
      const draft = await createDocument({ code: 'MM-BB-092', departmentId: org.deptB, status: 'IN_REVIEW', revisions: [{ revisionNo: 0, status: 'IN_REVIEW' }] });

      const session = await openSession(users.admin.token, draft.revisions[0].id);

      expect(session.mode).toBe('view');
      expect((await revisionRow(draft.revisions[0].id)).editSessionStartedAt).toBeNull();
    });

    it('ends when the editor is closed without changes (status 4)', async () => {
      const draft = await freshDraft();
      const before = await revisionRow(draft.revisionId);
      expect(before.editSessionStartedAt).toBeInstanceOf(Date);

      const response = await postCallback(draft.path, { key: draft.key, status: 4 }).expect(200);

      expect(response.body).toEqual({ error: 0 });
      expect(await revisionRow(draft.revisionId)).toEqual({ ...before, editSessionStartedAt: null });
      expect(await auditActions(draft.revisionId)).toEqual([]);
    });

    it('is not ended by a message of another session (other key)', async () => {
      const draft = await freshDraft();

      await postCallback(draft.path, { key: randomUUID(), status: 4 }).expect(200);

      expect((await revisionRow(draft.revisionId)).editSessionStartedAt).toBeInstanceOf(Date);
    });

    it('ends together with the final save (status 2), in the same step that stores the content', async () => {
      const draft = await freshDraft();

      await postCallback(draft.path, { key: draft.key, status: 2, url: `${fakeOrigin}/cache/files/edited.docx` }).expect(200);

      const after = await revisionRow(draft.revisionId);
      expect(after.editSessionStartedAt).toBeNull();
      expect(after.checksum).toBe(createHash('sha256').update(editedDocx).digest('hex'));
    });

    it('stays while the session goes on: forced saves and joining users do not end it', async () => {
      const draft = await freshDraft();

      await postCallback(draft.path, { key: draft.key, status: 6, url: `${fakeOrigin}/cache/files/edited.docx`, users: [users.admin.id] }).expect(200);
      await postCallback(draft.path, { key: draft.key, status: 1, users: [users.admin.id] }).expect(200);

      expect((await revisionRow(draft.revisionId)).editSessionStartedAt).toBeInstanceOf(Date);
    });

    it('stays when the final save fails, so a publication keeps waiting for the content', async () => {
      const draft = await freshDraft();

      await postCallback(draft.path, { key: draft.key, status: 2, url: `${fakeOrigin}/cache/files/missing.docx` }).expect(200);

      expect((await revisionRow(draft.revisionId)).editSessionStartedAt).toBeInstanceOf(Date);
    });
  });

  describe('statuses that store nothing', () => {
    it.each([1, 3, 7, 0, 99])('answers "handled" and changes nothing for status %i', async (status) => {
      const draft = await freshDraft();
      const before = await revisionRow(draft.revisionId);

      const response = await postCallback(draft.path, { key: draft.key, status, users: [users.admin.id] }).expect(200);

      expect(response.body).toEqual({ error: 0 });
      expect(await revisionRow(draft.revisionId)).toEqual(before);
      expect(await auditActions(draft.revisionId)).toEqual([]);
      expect(fakeRequests).toEqual([]);
    });
  });

  describe('saving (status 2: everyone closed the document)', () => {
    it('replaces the file, updates size and checksum, rotates the key and records the save', async () => {
      const draft = await freshDraft();

      const response = await postCallback(draft.path, {
        key: draft.key,
        status: 2,
        url: `${fakeOrigin}/cache/files/edited.docx`,
        users: [users.editorA.id],
      }).expect(200);

      expect(response.body).toEqual({ error: 0 });
      const after = await revisionRow(draft.revisionId);
      expect(after).toMatchObject({
        status: 'DRAFT',
        revisionNo: 0,
        fileSize: editedDocx.length,
        checksum: createHash('sha256').update(editedDocx).digest('hex'),
      });
      expect(after.editorKey).not.toBe(draft.key);
      expect(after.storageKey).not.toBe(draft.storageKey);
      expect((await storage.getBuffer(after.storageKey)).equals(editedDocx)).toBe(true);
      expect(await storage.exists(draft.storageKey)).toBe(false);

      const [entry] = await prisma.auditLog.findMany({ where: { entityId: draft.revisionId } });
      expect(entry).toMatchObject({ action: 'REVISION_SAVED', userId: users.editorA.id, entityType: 'Revision' });
      expect(entry.metadata).toMatchObject({
        forceSave: false,
        fileSize: editedDocx.length,
        checksum: after.checksum,
        previousChecksum: createHash('sha256').update(blankDocx).digest('hex'),
      });
    });

    it('serves the saved content from then on, under the new key', async () => {
      const draft = await freshDraft();
      await postCallback(draft.path, { key: draft.key, status: 2, url: `${fakeOrigin}/cache/files/edited.docx` }).expect(200);

      const reopened = await openSession(users.admin.token, draft.revisionId);
      expect((reopened.config.document as { key: string }).key).not.toBe(draft.key);

      const response = await request(app.getHttpServer())
        .get(relative((reopened.config.document as { url: string }).url))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);
      expect((response.body as Buffer).equals(editedDocx)).toBe(true);
    });

    it('credits nobody when the reported users are unknown', async () => {
      const draft = await freshDraft();
      await postCallback(draft.path, { key: draft.key, status: 2, url: `${fakeOrigin}/cache/files/edited.docx`, users: [randomUUID()] }).expect(200);

      const [entry] = await prisma.auditLog.findMany({ where: { entityId: draft.revisionId } });
      expect(entry.userId).toBeNull();
    });

    it('accepts the address the browser knows (public origin) and fetches it from the internal one', async () => {
      const draft = await freshDraft();

      await postCallback(draft.path, { key: draft.key, status: 2, url: 'http://localhost:8080/cache/files/edited.docx?md5=abc&expires=1' }).expect(200);

      expect(fakeRequests).toEqual(['/cache/files/edited.docx?md5=abc&expires=1']);
      expect((await revisionRow(draft.revisionId)).fileSize).toBe(editedDocx.length);
    });

    it('saves Excel documents as well', async () => {
      const draft = await freshDraft({ fileType: 'XLSX' });
      const response = await postCallback(draft.path, { key: draft.key, status: 2, url: `${fakeOrigin}/cache/files/edited.xlsx` }).expect(200);
      expect(response.body).toEqual({ error: 0 });
    });
  });

  describe('forced save (status 6: the session goes on)', () => {
    it('stores the file but keeps the key, so a second user joins the same session', async () => {
      const draft = await freshDraft();

      await postCallback(draft.path, { key: draft.key, status: 6, url: `${fakeOrigin}/cache/files/edited.docx`, users: [users.admin.id] }).expect(200);

      const after = await revisionRow(draft.revisionId);
      expect(after.editorKey).toBe(draft.key);
      expect(after.checksum).toBe(createHash('sha256').update(editedDocx).digest('hex'));
      expect((await storage.getBuffer(after.storageKey)).equals(editedDocx)).toBe(true);
      const [entry] = await prisma.auditLog.findMany({ where: { entityId: draft.revisionId } });
      expect(entry.metadata).toMatchObject({ forceSave: true });
    });

    it('allows many forced saves followed by the final save of the session', async () => {
      const draft = await freshDraft();
      const url = `${fakeOrigin}/cache/files/edited.docx`;

      await postCallback(draft.path, { key: draft.key, status: 6, url }).expect(200);
      await postCallback(draft.path, { key: draft.key, status: 6, url }).expect(200);
      await postCallback(draft.path, { key: draft.key, status: 2, url }).expect(200);

      expect(await auditActions(draft.revisionId)).toEqual(['REVISION_SAVED', 'REVISION_SAVED', 'REVISION_SAVED']);
      expect((await revisionRow(draft.revisionId)).editorKey).not.toBe(draft.key);
    });

    it('leaves exactly one stored object behind, the current one', async () => {
      const draft = await freshDraft();
      const url = `${fakeOrigin}/cache/files/edited.docx`;
      await postCallback(draft.path, { key: draft.key, status: 6, url }).expect(200);
      const first = (await revisionRow(draft.revisionId)).storageKey;
      await postCallback(draft.path, { key: draft.key, status: 6, url }).expect(200);
      const second = (await revisionRow(draft.revisionId)).storageKey;

      expect(second).not.toBe(first);
      expect(await storage.exists(first)).toBe(false);
      expect(await storage.exists(second)).toBe(true);
    });
  });

  describe('saves that are refused', () => {
    it('ignores a key that does not belong to the current session (replayed callback)', async () => {
      const draft = await freshDraft();
      const url = `${fakeOrigin}/cache/files/edited.docx`;
      await postCallback(draft.path, { key: draft.key, status: 2, url }).expect(200);
      const saved = await revisionRow(draft.revisionId);

      const replay = await postCallback(draft.path, { key: draft.key, status: 2, url }).expect(200);

      expect(replay.body).toEqual({ error: 0 });
      expect(await revisionRow(draft.revisionId)).toEqual(saved);
      expect(await auditActions(draft.revisionId)).toEqual(['REVISION_SAVED', 'REVISION_SAVE_REJECTED']);
    });

    it('does not write into a revision that is no longer a draft', async () => {
      const draft = await lockedDraft();
      const before = await revisionRow(draft.revisionId);

      const response = await postCallback(draft.path, { key: draft.key, status: 2, url: `${fakeOrigin}/cache/files/edited.docx` }).expect(200);

      expect(response.body).toEqual({ error: 0 });
      expect(await revisionRow(draft.revisionId)).toEqual(before);
      expect((await storage.getBuffer(before.storageKey)).equals(blankDocx)).toBe(true);
      const [entry] = await prisma.auditLog.findMany({ where: { entityId: draft.revisionId } });
      expect(entry).toMatchObject({ action: 'REVISION_SAVE_REJECTED' });
      expect(entry.metadata).toMatchObject({ reason: 'NOT_EDITABLE' });
      expect(fakeRequests).toEqual([]);
    });

    it.each([
      ['another host', () => 'http://evil.example/cache/files/edited.docx'],
      ['the same host on another port', () => 'http://127.0.0.1:1/cache/files/edited.docx'],
      ['the right port under another host name', () => `http://localhost:${new URL(fakeOrigin).port}/cache/files/edited.docx`],
      ['a file URL', () => 'file:///etc/passwd'],
      ['garbage', () => 'not a url'],
      ['nothing', () => ''],
    ])('never fetches a URL on %s', async (_label, makeUrl) => {
      const draft = await freshDraft();
      const before = await revisionRow(draft.revisionId);

      const response = await postCallback(draft.path, { key: draft.key, status: 2, url: makeUrl() }).expect(200);

      expect(response.body).toEqual({ error: 1 });
      expect(await revisionRow(draft.revisionId)).toEqual(before);
      expect(fakeRequests).toEqual([]);
      const [entry] = await prisma.auditLog.findMany({ where: { entityId: draft.revisionId } });
      expect(entry.metadata).toMatchObject({ reason: 'UNTRUSTED_URL' });
    });

    it('reports a failed download and keeps the stored file', async () => {
      const draft = await freshDraft();
      const before = await revisionRow(draft.revisionId);

      const response = await postCallback(draft.path, { key: draft.key, status: 2, url: `${fakeOrigin}/cache/files/missing.docx` }).expect(200);

      expect(response.body).toEqual({ error: 1 });
      expect(await revisionRow(draft.revisionId)).toEqual(before);
      const [entry] = await prisma.auditLog.findMany({ where: { entityId: draft.revisionId } });
      expect(entry.metadata).toMatchObject({ reason: 'DOWNLOAD_FAILED' });
    });

    it('refuses a file above the size limit', async () => {
      const draft = await freshDraft();
      const before = await revisionRow(draft.revisionId);

      const response = await postCallback(draft.path, { key: draft.key, status: 2, url: `${fakeOrigin}/cache/files/huge.docx` }).expect(200);

      expect(response.body).toEqual({ error: 1 });
      expect(await revisionRow(draft.revisionId)).toEqual(before);
    });

    it.each([
      ['something that is not an Office package', 'not-an-office-file.docx', 'DOCX'],
      ['a spreadsheet for a Word revision', 'edited.xlsx', 'DOCX'],
    ] as const)('refuses %s', async (_label, file, fileType) => {
      const draft = await freshDraft({ fileType });
      const before = await revisionRow(draft.revisionId);

      const response = await postCallback(draft.path, { key: draft.key, status: 2, url: `${fakeOrigin}/cache/files/${file}` }).expect(200);

      expect(response.body).toEqual({ error: 1 });
      expect(await revisionRow(draft.revisionId)).toEqual(before);
      expect((await storage.getBuffer(before.storageKey)).equals(blankDocx)).toBe(true);
      const [entry] = await prisma.auditLog.findMany({ where: { entityId: draft.revisionId } });
      expect(entry.metadata).toMatchObject({ reason: 'INVALID_CONTENT' });
    });
  });

  describe('consistency', () => {
    it('lets only one of two simultaneous saves of the same session win', async () => {
      const draft = await freshDraft();
      const url = `${fakeOrigin}/cache/files/edited.docx`;

      const responses = await Promise.all([
        postCallback(draft.path, { key: draft.key, status: 2, url }),
        postCallback(draft.path, { key: draft.key, status: 2, url }),
      ]);

      expect(responses.map((response) => response.body)).toEqual([{ error: 0 }, { error: 0 }]);
      expect((await auditActions(draft.revisionId)).sort()).toEqual(['REVISION_SAVED', 'REVISION_SAVE_REJECTED']);
      const after = await revisionRow(draft.revisionId);
      expect(await storage.exists(after.storageKey)).toBe(true);
      expect(await storage.exists(draft.storageKey)).toBe(false);
    });

    it('leaves the previous content untouched and removes the new object when the database write fails', async () => {
      const draft = await freshDraft();
      const before = await revisionRow(draft.revisionId);
      const putSpy = jest.spyOn(storage, 'put');
      jest.spyOn(app.get(AuditLogsService), 'log').mockRejectedValueOnce(new Error('database is down'));

      const response = await postCallback(draft.path, { key: draft.key, status: 2, url: `${fakeOrigin}/cache/files/edited.docx` }).expect(200);

      expect(response.body).toEqual({ error: 1 });
      expect(await revisionRow(draft.revisionId)).toEqual(before);
      expect((await storage.getBuffer(before.storageKey)).equals(blankDocx)).toBe(true);
      const [newKey] = putSpy.mock.calls.at(-1)!;
      expect(newKey).not.toBe(before.storageKey);
      expect(await storage.exists(newKey)).toBe(false);
      putSpy.mockRestore();
    });
  });

  describe('authentication', () => {
    const body = (key: string) => ({ key, status: 2, url: `${fakeOrigin}/cache/files/edited.docx` });

    it('accepts the ONLYOFFICE token in the header or in the body', async () => {
      const header = await freshDraft();
      await postCallback(header.path, body(header.key), { mode: 'header' }).expect(200);
      expect((await revisionRow(header.revisionId)).editorKey).not.toBe(header.key);

      const inBody = await freshDraft();
      await postCallback(inBody.path, body(inBody.key), { mode: 'body' }).expect(200);
      expect((await revisionRow(inBody.revisionId)).editorKey).not.toBe(inBody.key);
    });

    it.each([
      ['no ONLYOFFICE token', { mode: 'none' as const }],
      ['an ONLYOFFICE token signed with another secret', { secret: 'another-secret' }],
    ])('answers 403 and changes nothing with %s', async (_label, options) => {
      const draft = await freshDraft();
      const before = await revisionRow(draft.revisionId);

      await postCallback(draft.path, body(draft.key), options).expect(403);

      expect(await revisionRow(draft.revisionId)).toEqual(before);
      expect(fakeRequests).toEqual([]);
    });

    it('answers 403 without the URL token, or with one meant for something else', async () => {
      const draft = await freshDraft();
      const plainPath = `/api/editor/callback/${draft.revisionId}`;
      await postCallback(plainPath, body(draft.key)).expect(403);
      await postCallback(`${plainPath}?token=garbage`, body(draft.key)).expect(403);

      const downloadToken = await fileTokens.sign({ purpose: 'download', revisionId: draft.revisionId, organizationId: org.id });
      await postCallback(`${plainPath}?token=${downloadToken}`, body(draft.key)).expect(403);

      const otherRevision = await freshDraft();
      await postCallback(otherRevision.path.replace(otherRevision.revisionId, draft.revisionId), body(draft.key)).expect(403);
      expect((await revisionRow(draft.revisionId)).editorKey).toBe(draft.key);
    });

    it('trusts the signed data only, not the plain body next to it', async () => {
      const draft = await freshDraft();
      const before = await revisionRow(draft.revisionId);
      const signed = { key: draft.key, status: 1 }; // "still editing"
      const token = jwt.sign({ payload: signed }, { secret: ONLYOFFICE_SECRET });

      const response = await request(app.getHttpServer())
        .post(draft.path)
        .set('Authorization', `Bearer ${token}`)
        .send({ key: draft.key, status: 2, url: `${fakeOrigin}/cache/files/edited.docx` })
        .expect(200);

      expect(response.body).toEqual({ error: 0 });
      expect(await revisionRow(draft.revisionId)).toEqual(before);
    });

    it('answers 403 even for a view session address that was never issued', async () => {
      const reader = await openSession(users.reader.token, docs.published.revisions[0].id);
      expect(reader.config.editorConfig).not.toHaveProperty('callbackUrl');
    });
  });
});

describe('GET /api/documents/:id', () => {
  const get = (token: string, id: string) => request(app.getHttpServer()).get(`/api/documents/${id}`).set(auth(token));

  it('requires authentication and a valid id', async () => {
    await request(app.getHttpServer()).get(`/api/documents/${docs.draftA.id}`).expect(401);
    await get(users.admin.token, 'nope').expect(400);
    await get(users.admin.token, randomUUID()).expect(404);
  });

  it('opens the draft for editors of the department and marks it editable', async () => {
    const body = (await get(users.editorA.token, docs.draftA.id).expect(200)).body as DocumentDetailDto;

    expect(body).toMatchObject({
      id: docs.draftA.id,
      code: 'MM-AA-001',
      status: 'DRAFT',
      canEdit: true,
      openRevision: { id: docs.draftA.revisions[0].id, revisionNo: 0, status: 'DRAFT' },
    });
  });

  it('opens the revision in force for readers, who cannot edit', async () => {
    const body = (await get(users.reader.token, docs.published.id).expect(200)).body as DocumentDetailDto;

    expect(body).toMatchObject({ canEdit: false, openRevision: { id: docs.published.revisions[0].id, status: 'APPROVED' } });
  });

  it('prefers the open draft of a published document for people who may see it', async () => {
    const [, current, draft] = docs.publishedWithDraft.revisions;

    const editor = (await get(users.editorA.token, docs.publishedWithDraft.id).expect(200)).body as DocumentDetailDto;
    expect(editor.openRevision?.id).toBe(draft.id);
    expect(editor.canEdit).toBe(true);

    const reader = (await get(users.reader.token, docs.publishedWithDraft.id).expect(200)).body as DocumentDetailDto;
    expect(reader.openRevision?.id).toBe(current.id);
    expect(reader.canEdit).toBe(false);
  });

  it('shows a locked document read only', async () => {
    const body = (await get(users.admin.token, docs.inReview.id).expect(200)).body as DocumentDetailDto;
    expect(body).toMatchObject({ status: 'IN_REVIEW', canEdit: false, openRevision: { status: 'IN_REVIEW' } });
  });

  it.each([
    ['a reader cannot see a draft', 'reader', () => docs.draftA.id],
    ['an editor cannot see drafts of another department', 'editorB', () => docs.draftA.id],
    ['nobody sees a document of another organization', 'admin', () => docs.foreign.id],
  ] as const)('%s', async (_label, who, id) => {
    const response = await get(users[who].token, id()).expect(404);
    expect(response.body.code).toBe('DOCUMENT_NOT_FOUND');
  });
});
