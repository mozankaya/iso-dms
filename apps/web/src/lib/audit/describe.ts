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

function userRole(role: string | null): string | null {
  if (!role) return null;
  return role in tr.admin.users.roles ? tr.admin.users.roles[role as keyof typeof tr.admin.users.roles] : role;
}

function templateType(type: string | null): string | null {
  if (!type) return null;
  return type in tr.admin.templates.fileTypes ? tr.admin.templates.fileTypes[type as keyof typeof tr.admin.templates.fileTypes] : type;
}

function reason(code: string | null): string | null {
  if (!code) return null;
  return code in t.details.reasons ? t.details.reasons[code as keyof typeof t.details.reasons] : code;
}

/** Name of the action in Turkish; an action this build does not know is shown as it is. */
export function actionLabel(action: string): string {
  return action in t.actions ? t.actions[action as AuditAction] : action;
}

function changesOf(metadata: Record<string, unknown> | null | undefined): Record<string, { to?: unknown }> {
  const changes = metadata?.changes;
  return changes && typeof changes === "object" ? (changes as Record<string, { to?: unknown }>) : {};
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
    case "REVISION_STARTED": {
      const source = number(metadata, "sourceRevisionNo");
      parts.push(source !== null ? t.details.startedFrom(source) : null);
      parts.push(text(metadata, "changeSummary"));
      break;
    }
    case "REVISION_SUBMITTED":
      parts.push(t.details.submittedAs(text(metadata, "type") ?? "REVISION"));
      break;
    case "APPROVAL_APPROVED":
    case "APPROVAL_REJECTED": {
      const step = number(metadata, "stepOrder");
      parts.push(step !== null ? t.details.step(step) : null);
      parts.push(metadata?.final === true ? t.details.finalApproval : null);
      parts.push(text(metadata, "comment"));
      break;
    }
    case "FEEDBACK_RESOLVED":
      parts.push(text(metadata, "note"));
      break;
    case "REVISION_CANCELLED":
    case "WITHDRAWAL_REQUESTED":
    case "DOCUMENT_WITHDRAWN":
      parts.push(text(metadata, "reason"));
      break;
    case "REVISION_SAVED":
      parts.push(metadata?.forceSave === true ? t.details.savedManually : t.details.savedOnClose);
      parts.push(formatFileSize(number(metadata, "fileSize")));
      break;
    case "REVISION_SAVE_REJECTED":
      parts.push(reason(text(metadata, "reason")));
      break;
    case "REVISION_PDF_GENERATED":
      parts.push(formatFileSize(number(metadata, "fileSize")));
      break;
    case "REVISION_PDF_FAILED":
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
    case "DEPARTMENT_CREATED":
    case "CATEGORY_CREATED":
      parts.push(text(metadata, "name"));
      parts.push(text(metadata, "code") ?? text(metadata, "codePrefix"));
      break;
    case "DEPARTMENT_UPDATED":
    case "CATEGORY_UPDATED": {
      const changes = changesOf(metadata);
      parts.push(text(metadata, "code") ?? text(metadata, "codePrefix"));
      for (const key of Object.keys(changes)) {
        if (key === "isActive") {
          parts.push(changes[key].to === true ? t.details.activated : t.details.deactivated);
        } else {
          parts.push(t.details.changedFields[key] ?? key);
        }
      }
      break;
    }
    case "TEMPLATE_CREATED":
      parts.push(text(metadata, "name"));
      parts.push(templateType(text(metadata, "fileType")));
      parts.push(metadata?.isDefault === true ? t.details.changedFields.isDefault : null);
      break;
    case "TEMPLATE_UPDATED": {
      parts.push(text(metadata, "name"));
      for (const key of Object.keys(changesOf(metadata))) parts.push(t.details.changedFields[key] ?? key);
      break;
    }
    case "TEMPLATE_FILE_REPLACED":
      parts.push(text(metadata, "name"));
      parts.push(formatFileSize(number(metadata, "fileSize")));
      break;
    case "TEMPLATE_DELETED":
      parts.push(text(metadata, "name"));
      parts.push(templateType(text(metadata, "fileType")));
      break;
    case "USER_CREATED":
      parts.push(text(metadata, "email"));
      parts.push(userRole(text(metadata, "role")));
      parts.push(text(metadata, "departmentCode"));
      parts.push(metadata?.passwordGenerated === true ? t.details.passwordGenerated : t.details.passwordChosen);
      break;
    case "USER_UPDATED": {
      parts.push(text(metadata, "email"));
      const changes = changesOf(metadata);
      for (const key of Object.keys(changes)) {
        if (key === "isActive") {
          parts.push(changes[key].to === true ? t.details.activated : t.details.deactivated);
        } else {
          parts.push(t.details.changedFields[key] ?? key);
        }
      }
      break;
    }
    case "USER_PASSWORD_RESET":
      parts.push(text(metadata, "email"));
      parts.push(metadata?.passwordGenerated === true ? t.details.passwordGenerated : t.details.passwordChosen);
      break;
    case "USER_PASSWORD_CHANGED":
      parts.push(metadata?.wasTemporary === true ? t.details.temporaryChanged : null);
      break;
    case "REFRESH_TOKEN_REUSE_DETECTED":
      parts.push(t.details.sessionsClosed);
      break;
  }

  return parts.filter((part): part is string => part !== null && part !== "-").join(" · ");
}
