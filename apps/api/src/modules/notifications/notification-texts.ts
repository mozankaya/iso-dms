import type { NotificationType } from '@iso-dms/shared';

/**
 * The Turkish texts of the notifications. They are written here, on the server, because the same text goes into
 * the in-app message and the e-mail (the rest of the user interface keeps its texts in the web application).
 */
export interface NotificationContent {
  type: NotificationType;
  title: string;
  body: string;
  link: string;
}

type RequestKind = 'NEW' | 'REVISION' | 'WITHDRAWAL';

const WHAT: Record<RequestKind, string> = {
  NEW: 'yeni doküman',
  REVISION: 'revizyon',
  WITHDRAWAL: 'yayından kaldırma talebi',
};

interface DocumentRef {
  documentId: string;
  code: string;
  title: string;
}

/** A step of an approval request is waiting for the recipient. */
export function approvalStepWaiting(input: DocumentRef & { kind: RequestKind; stepOrder: number }): NotificationContent {
  return {
    type: 'APPROVAL_STEP_WAITING',
    title: `Onayınızı bekleyen ${WHAT[input.kind]}: ${input.code}`,
    body: `${input.code} ${input.title} için ${input.stepOrder}. adım onayınızı bekliyor (${WHAT[input.kind]}).`,
    link: '/approvals',
  };
}

/** The request was approved (the revision is in force, or the document was withdrawn). */
export function requestApproved(input: DocumentRef & { kind: RequestKind }): NotificationContent {
  const outcome = input.kind === 'WITHDRAWAL' ? 'onaylandı ve doküman yayından kaldırıldı' : 'onaylandı ve yürürlüğe girdi';
  return {
    type: 'REQUEST_APPROVED',
    title: `${input.code} ${outcome}`,
    body: `${input.code} ${input.title} için gönderilen ${WHAT[input.kind]} ${outcome}.`,
    link: `/documents/${input.documentId}`,
  };
}

/** The request was rejected, with the reason of the one who rejected it. */
export function requestRejected(input: DocumentRef & { kind: RequestKind; comment: string | null }): NotificationContent {
  return {
    type: 'REQUEST_REJECTED',
    title: `${input.code} için ${WHAT[input.kind]} reddedildi`,
    body: `${input.code} ${input.title} için gönderilen ${WHAT[input.kind]} reddedildi.${input.comment ? ` Gerekçe: ${input.comment}` : ''}`,
    link: `/documents/${input.documentId}`,
  };
}
