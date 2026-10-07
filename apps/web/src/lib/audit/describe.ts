import type { AuditAction, AuditLogDto } from "@iso-dms/shared";
import { formatFileSize } from "@/lib/format";
import { tr } from "@/lib/i18n/tr";

const t = tr.audit;

function text(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function number(metadata: Record<string, unknown> | null, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" ? value : null;
}

function reason(code: string | null): string | null {
  if (!code) return null;
  return code in t.details.reasons ? t.details.reasons[code as keyof typeof t.details.reasons] : code;
}

/** Name of the action in Turkish; an action this build does not know is shown as it is. */
export function actionLabel(action: string): string {
  return action in t.actions ? t.actions[action as AuditAction] : action;
}

/** One short Turkish line with the facts that matter for an entry, built from what the API stored. */
export function describeEntry(entry: Pick<AuditLogDto, "action" | "metadata">): string {
  const { metadata } = entry;
  const parts: (string | null)[] = [];

  switch (entry.action) {
    case "DOCUMENT_OPENED":
      parts.push(text(metadata, "mode") === "edit" ? t.details.modeEdit : t.details.modeView);
      break;
    case "DOCUMENT_CREATED":
      parts.push(text(metadata, "source") === "UPLOAD" ? t.details.sourceUpload : t.details.sourceTemplate);
      break;
    case "REVISION_SAVED":
      parts.push(metadata?.forceSave === true ? t.details.savedManually : t.details.savedOnClose);
      parts.push(formatFileSize(number(metadata, "fileSize")));
      break;
    case "REVISION_SAVE_REJECTED":
      parts.push(reason(text(metadata, "reason")));
      break;
    case "REVISION_DOWNLOADED":
      parts.push(formatFileSize(number(metadata, "fileSize")));
      break;
    case "DOCUMENT_PUBLISHED": {
      const previous = number(metadata, "previousRevisionNo");
      parts.push(metadata?.firstPublication === true ? t.details.firstPublication : null);
      parts.push(previous !== null ? t.details.supersedes(previous) : null);
      break;
    }
    case "USER_LOGIN_FAILED":
      parts.push(reason(text(metadata, "reason")));
      parts.push(text(metadata, "email"));
      break;
    case "REFRESH_TOKEN_REUSE_DETECTED":
      parts.push(t.details.sessionsClosed);
      break;
  }

  return parts.filter((part): part is string => part !== null && part !== "-").join(" · ");
}
