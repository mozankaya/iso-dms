import type { PublicationListKind } from '@iso-dms/shared';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { DocumentWhereInput } from '../../generated/prisma/models';
import { visibilityFilter } from '../documents/document-access.policy';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The date each list is about, and the status the documents of the list have. */
export const LIST_DATE_FIELD = { new: 'firstPublishedAt', revised: 'revisedAt', withdrawn: 'withdrawnAt' } as const;

/** Start of a rolling window of `days` days ending now. */
export function windowStart(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Which documents belong to a publication list, for one user (PROJECT.md 6.4.1 decides what they may see):
 * - new: published documents first published since the start of the window,
 * - revised: published documents whose revision in force was published since then,
 * - withdrawn: documents withdrawn since then.
 * New and revised only list documents that are in force now: a document that was withdrawn since is not news.
 * A missing `since` means no limit in time. Counters and lists share this, so they always agree.
 */
export function publicationWhere(user: AuthenticatedUser, kind: PublicationListKind, since: Date | null): DocumentWhereInput {
  const field = LIST_DATE_FIELD[kind];
  const visibility = visibilityFilter(user);
  return {
    AND: [
      { organizationId: user.organizationId },
      { status: kind === 'withdrawn' ? 'WITHDRAWN' : 'PUBLISHED' },
      { [field]: since ? { gte: since } : { not: null } },
      ...(visibility ? [visibility] : []),
    ],
  };
}
