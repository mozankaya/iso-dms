import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { ApprovalStepDto, DocumentDetailDto } from '@iso-dms/shared';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Takes a draft through the whole approval (PROJECT.md 6.3) the way people do: it is sent to review, the
 * department approver approves, then the quality manager. The three must be different people from the preparer.
 * Returns the document as it is after the last approval.
 */
export async function publishThroughApproval(
  app: INestApplication,
  input: { revisionId: string; submitToken: string; approverToken: string; qualityToken: string },
): Promise<DocumentDetailDto> {
  const server = app.getHttpServer();
  const submitted = await request(server).post(`/api/revisions/${input.revisionId}/submit`).set(auth(input.submitToken)).expect(200);
  const steps = (submitted.body as DocumentDetailDto).approval!.steps as ApprovalStepDto[];

  await request(server).post(`/api/approvals/${steps[0].id}/approve`).set(auth(input.approverToken)).send({}).expect(200);
  const last = await request(server).post(`/api/approvals/${steps[1].id}/approve`).set(auth(input.qualityToken)).send({}).expect(200);
  return last.body as DocumentDetailDto;
}
