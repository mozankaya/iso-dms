import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

const SEQUENCE_DIGITS = 3;

/**
 * Document code generation (PROJECT.md 6.1): {CATEGORY_PREFIX}-{DEPARTMENT_CODE}-{SEQUENCE}, e.g. PR-KK-001.
 * The format lives here only, so it can be made configurable later.
 */
@Injectable()
export class DocumentCodeService {
  format(categoryPrefix: string, departmentCode: string, sequenceNo: number): string {
    return `${categoryPrefix}-${departmentCode}-${String(sequenceNo).padStart(SEQUENCE_DIGITS, '0')}`;
  }

  /**
   * Reserves the next sequence number for an organization + category + department and returns it with
   * the resulting code. Must run inside the transaction that inserts the document: the advisory lock
   * serialises concurrent creations for the same combination until that transaction ends. Rows are never
   * deleted once published, so the code of a withdrawn document is never handed out again.
   * The unique constraints on the Document table remain the safety net.
   */
  async allocate(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      categoryId: string;
      categoryPrefix: string;
      departmentId: string;
      departmentCode: string;
    },
  ): Promise<{ sequenceNo: number; code: string }> {
    const lockKey = `document-code:${params.organizationId}:${params.categoryId}:${params.departmentId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

    const { _max } = await tx.document.aggregate({
      where: {
        organizationId: params.organizationId,
        categoryId: params.categoryId,
        departmentId: params.departmentId,
      },
      _max: { sequenceNo: true },
    });

    const sequenceNo = (_max.sequenceNo ?? 0) + 1;
    return { sequenceNo, code: this.format(params.categoryPrefix, params.departmentCode, sequenceNo) };
  }
}
