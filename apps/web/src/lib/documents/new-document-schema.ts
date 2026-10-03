import { DEFAULT_MAX_UPLOAD_MB, FILE_TYPES, type FileType } from "@iso-dms/shared";
import { z } from "zod";
import { tr } from "@/lib/i18n/tr";

const v = tr.newDocument.validation;

export const MAX_UPLOAD_BYTES = DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;

const EXTENSION_TO_TYPE: Record<string, FileType> = { docx: "DOCX", xlsx: "XLSX" };

/** File type derived from the file name, or null when the extension is not supported. */
export function fileTypeOf(fileName: string): FileType | null {
  const parts = fileName.split(".");
  if (parts.length < 2) return null;
  return EXTENSION_TO_TYPE[parts.at(-1)!.toLowerCase()] ?? null;
}

/** Default document title for an uploaded file: the file name without its extension. */
export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim().slice(0, 200);
}

export const newDocumentSchema = z
  .object({
    categoryId: z.string().min(1, v.categoryRequired),
    departmentId: z.string().min(1, v.departmentRequired),
    title: z
      .string()
      .trim()
      .min(1, v.titleRequired)
      .min(3, v.titleTooShort)
      .max(200, v.titleTooLong),
    source: z.enum(["template", "upload"]),
    fileType: z.enum(FILE_TYPES),
    /** Empty string means "use the default template" */
    templateId: z.string(),
    file: z.instanceof(File).nullable(),
  })
  .superRefine((values, context) => {
    if (values.source !== "upload") return;

    const addFileIssue = (message: string) =>
      context.addIssue({ code: "custom", path: ["file"], message });

    if (!values.file) return addFileIssue(v.fileRequired);
    if (!fileTypeOf(values.file.name)) return addFileIssue(v.fileTypeUnsupported);
    if (values.file.size === 0) return addFileIssue(v.fileEmpty);
    if (values.file.size > MAX_UPLOAD_BYTES) return addFileIssue(v.fileTooLarge(DEFAULT_MAX_UPLOAD_MB));
  });

export type NewDocumentValues = z.infer<typeof newDocumentSchema>;
