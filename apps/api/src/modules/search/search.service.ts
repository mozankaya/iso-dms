import { BadRequestException, Injectable } from '@nestjs/common';
import { SEARCH_MAX_RESULTS, type PaginatedDto, type SearchResultDto } from '@iso-dms/shared';
import { Prisma } from '../../generated/prisma/client';
import type { DocumentWhereInput } from '../../generated/prisma/models';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { canEditListedDocument, visibilityFilter } from '../documents/document-access.policy';
import { DOCUMENT_LIST_SELECT, toDocumentListItem } from '../documents/document-list-item';
import { SearchDto } from './dto/search.dto';
import { buildSnippets, parseSearchQuery, toTsQuery } from './search-text';

/**
 * Full text search over the documents in force (PROJECT.md 6.16). Who may see which document is decided by the same
 * `visibilityFilter` as everywhere else; the index only says which documents contain the words and how well.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(user: AuthenticatedUser, query: SearchDto): Promise<PaginatedDto<SearchResultDto>> {
    const groups = parseSearchQuery(query.q);
    if (groups.length === 0) {
      throw new BadRequestException({ code: 'SEARCH_QUERY_INVALID', message: 'The search has no words in it' });
    }

    // Documents whose indexed text (content, code, title) has all the words, best match first
    const hits = await this.prisma.$queryRaw<{ id: string; rank: number }[]>(Prisma.sql`
      SELECT rt."documentId" AS id, ts_rank(rt."searchVector", q.query)::float8 AS rank
      FROM "RevisionText" rt
      JOIN "Document" d ON d."id" = rt."documentId" AND d."currentRevisionId" = rt."revisionId" AND d."status" = 'PUBLISHED',
        to_tsquery('simple', ${toTsQuery(groups)}) AS q(query)
      WHERE rt."organizationId" = ${user.organizationId} AND rt."status" = 'INDEXED' AND rt."searchVector" @@ q.query
      ORDER BY rank DESC
      LIMIT ${SEARCH_MAX_RESULTS}`);
    const rankOf = new Map(hits.map((hit) => [hit.id, hit.rank]));

    // A document that is not indexed yet (just published) is still found by its code and title
    const name = query.q.replace(/"/g, '').replace(/[\\%_]/g, '\\$&').trim();
    const and: DocumentWhereInput[] = [
      { organizationId: user.organizationId },
      { status: 'PUBLISHED' },
      {
        OR: [
          { id: { in: [...rankOf.keys()] } },
          { code: { contains: name, mode: 'insensitive' } },
          { title: { contains: name, mode: 'insensitive' } },
        ],
      },
    ];
    const visibility = visibilityFilter(user);
    if (visibility) and.push(visibility);
    if (query.categoryId) and.push({ categoryId: query.categoryId });
    if (query.departmentId) and.push({ departmentId: query.departmentId });

    const documents = await this.prisma.document.findMany({
      where: { AND: and },
      select: { ...DOCUMENT_LIST_SELECT, currentRevisionId: true },
      take: SEARCH_MAX_RESULTS,
      orderBy: { code: 'asc' },
    });
    documents.sort((a, b) => (rankOf.get(b.id) ?? 0) - (rankOf.get(a.id) ?? 0) || a.code.localeCompare(b.code));

    const pageItems = documents.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
    const texts = await this.prisma.revisionText.findMany({
      where: { revisionId: { in: pageItems.flatMap((document) => (document.currentRevisionId ? [document.currentRevisionId] : [])) }, status: 'INDEXED' },
      select: { revisionId: true, content: true },
    });
    const contentOf = new Map(texts.map((text) => [text.revisionId, text.content]));

    return {
      items: pageItems.map((document) => ({
        ...toDocumentListItem(document, canEditListedDocument(user, { status: document.status, departmentId: document.department.id })),
        snippets: rankOf.has(document.id) ? buildSnippets(contentOf.get(document.currentRevisionId ?? '') ?? '', groups) : [],
      })),
      total: documents.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}
