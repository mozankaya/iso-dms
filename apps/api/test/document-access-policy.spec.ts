import type { AuthenticatedUser } from '../src/common/types/authenticated-user';
import type { UserRole } from '../src/generated/prisma/enums';
import {
  canEditListedDocument,
  canEditRevision,
  canViewRevision,
  canWriteInDepartment,
  visibilityFilter,
} from '../src/modules/documents/document-access.policy';

const DEPT_A = 'dept-a';
const DEPT_B = 'dept-b';

function user(role: UserRole, departmentId: string | null = DEPT_A): AuthenticatedUser {
  return { id: 'u1', organizationId: 'o1', role, departmentId };
}

const published = { status: 'PUBLISHED' as const, departmentId: DEPT_A, currentRevisionId: 'rev-current' };
const draftOnly = { status: 'DRAFT' as const, departmentId: DEPT_A, currentRevisionId: null };

describe('canWriteInDepartment', () => {
  it.each([
    ['EDITOR', DEPT_A, true],
    ['EDITOR', DEPT_B, false],
    ['APPROVER', DEPT_A, true],
    ['APPROVER', DEPT_B, false],
    ['QUALITY_MANAGER', DEPT_B, true],
    ['ADMIN', DEPT_B, true],
    ['READER', DEPT_A, false],
  ] as const)('%s in %s -> %s', (role, department, expected) => {
    expect(canWriteInDepartment(user(role), department)).toBe(expected);
  });

  it('refuses department bound roles that have no department', () => {
    expect(canWriteInDepartment(user('EDITOR', null), DEPT_A)).toBe(false);
    expect(canWriteInDepartment(user('APPROVER', null), DEPT_A)).toBe(false);
  });

  it('lets quality managers and admins without a department write anywhere', () => {
    expect(canWriteInDepartment(user('QUALITY_MANAGER', null), DEPT_B)).toBe(true);
  });
});

describe('visibilityFilter', () => {
  it('limits readers to published documents', () => {
    expect(visibilityFilter(user('READER'))).toEqual({ status: 'PUBLISHED' });
  });

  it('gives editors published documents plus the non-published ones of their department', () => {
    expect(visibilityFilter(user('EDITOR'))).toEqual({
      OR: [{ status: 'PUBLISHED' }, { departmentId: DEPT_A, status: { not: 'PUBLISHED' } }],
    });
  });

  it('gives editors without a department published documents only', () => {
    expect(visibilityFilter(user('EDITOR', null))).toEqual({ OR: [{ status: 'PUBLISHED' }] });
  });

  it.each(['APPROVER', 'QUALITY_MANAGER', 'ADMIN'] as const)('does not restrict %s', (role) => {
    expect(visibilityFilter(user(role))).toBeUndefined();
  });
});

describe('canViewRevision', () => {
  it('lets readers open only the revision in force of a published document', () => {
    expect(canViewRevision(user('READER'), published, 'rev-current')).toBe(true);
    expect(canViewRevision(user('READER'), published, 'rev-new-draft')).toBe(false);
    expect(canViewRevision(user('READER'), published, 'rev-old')).toBe(false);
    expect(canViewRevision(user('READER'), draftOnly, 'rev-1')).toBe(false);
  });

  it('does not let readers open anything of a withdrawn document', () => {
    const withdrawn = { ...published, status: 'WITHDRAWN' as const };
    expect(canViewRevision(user('READER'), withdrawn, 'rev-current')).toBe(false);
  });

  it('lets editors open the revision in force and every revision of their own department', () => {
    expect(canViewRevision(user('EDITOR'), published, 'rev-current')).toBe(true);
    expect(canViewRevision(user('EDITOR'), published, 'rev-new-draft')).toBe(true);
    expect(canViewRevision(user('EDITOR'), draftOnly, 'rev-1')).toBe(true);
  });

  it('keeps editors of other departments to the revision in force', () => {
    const other = user('EDITOR', DEPT_B);
    expect(canViewRevision(other, published, 'rev-current')).toBe(true);
    expect(canViewRevision(other, published, 'rev-new-draft')).toBe(false);
    expect(canViewRevision(other, draftOnly, 'rev-1')).toBe(false);
  });

  it('keeps editors without a department to the revision in force', () => {
    expect(canViewRevision(user('EDITOR', null), draftOnly, 'rev-1')).toBe(false);
  });

  it.each(['APPROVER', 'QUALITY_MANAGER', 'ADMIN'] as const)('lets %s open any revision', (role) => {
    expect(canViewRevision(user(role, DEPT_B), draftOnly, 'rev-1')).toBe(true);
    expect(canViewRevision(user(role, DEPT_B), published, 'rev-old')).toBe(true);
  });
});

describe('canEditRevision', () => {
  const draftRevision = { status: 'DRAFT' as const };

  it('allows editing an open draft in a department the user may write in', () => {
    expect(canEditRevision(user('EDITOR'), draftOnly, draftRevision)).toBe(true);
    expect(canEditRevision(user('QUALITY_MANAGER', null), draftOnly, draftRevision)).toBe(true);
  });

  it('denies editing in another department', () => {
    expect(canEditRevision(user('EDITOR', DEPT_B), draftOnly, draftRevision)).toBe(false);
    expect(canEditRevision(user('APPROVER', DEPT_B), draftOnly, draftRevision)).toBe(false);
  });

  it('denies readers', () => {
    expect(canEditRevision(user('READER'), draftOnly, draftRevision)).toBe(false);
  });

  it.each(['IN_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const)('locks a %s revision', (status) => {
    expect(canEditRevision(user('ADMIN'), draftOnly, { status })).toBe(false);
  });

  it('never edits a withdrawn document', () => {
    expect(canEditRevision(user('ADMIN'), { status: 'WITHDRAWN', departmentId: DEPT_A }, draftRevision)).toBe(false);
  });

  it('allows a new draft revision of a published document', () => {
    expect(canEditRevision(user('EDITOR'), published, draftRevision)).toBe(true);
  });
});

describe('canEditListedDocument', () => {
  it('is true only for drafts in a department the user may write in', () => {
    expect(canEditListedDocument(user('EDITOR'), { status: 'DRAFT', departmentId: DEPT_A })).toBe(true);
    expect(canEditListedDocument(user('EDITOR'), { status: 'DRAFT', departmentId: DEPT_B })).toBe(false);
    expect(canEditListedDocument(user('ADMIN'), { status: 'DRAFT', departmentId: DEPT_B })).toBe(true);
    expect(canEditListedDocument(user('ADMIN'), { status: 'PUBLISHED', departmentId: DEPT_A })).toBe(false);
    expect(canEditListedDocument(user('ADMIN'), { status: 'IN_REVIEW', departmentId: DEPT_A })).toBe(false);
    expect(canEditListedDocument(user('READER'), { status: 'DRAFT', departmentId: DEPT_A })).toBe(false);
  });
});
