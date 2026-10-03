import { describe, expect, it } from "vitest";
import { tr } from "@/lib/i18n/tr";
import {
  fileTypeOf,
  MAX_UPLOAD_BYTES,
  newDocumentSchema,
  titleFromFileName,
} from "./new-document-schema";

const valid = {
  categoryId: "c1",
  departmentId: "d1",
  title: "Doküman Kontrol Prosedürü",
  source: "template" as const,
  fileType: "DOCX" as const,
  templateId: "",
  file: null,
};

function fileOfSize(name: string, size: number): File {
  return new File([new Uint8Array(size)], name);
}

function messages(input: unknown): string[] {
  const result = newDocumentSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("fileTypeOf", () => {
  it.each([
    ["rapor.docx", "DOCX"],
    ["RAPOR.DOCX", "DOCX"],
    ["tablo.xlsx", "XLSX"],
    ["a.b.c.xlsx", "XLSX"],
  ])("recognises %s", (name, type) => {
    expect(fileTypeOf(name)).toBe(type);
  });

  it.each(["rapor.doc", "rapor.pdf", "rapor", "docx", ""])("rejects %j", (name) => {
    expect(fileTypeOf(name)).toBeNull();
  });
});

describe("titleFromFileName", () => {
  it("drops the extension and keeps Turkish characters", () => {
    expect(titleFromFileName("Prosedür Taslağı.xlsx")).toBe("Prosedür Taslağı");
    expect(titleFromFileName("v1.2 plan.docx")).toBe("v1.2 plan");
  });
});

describe("newDocumentSchema", () => {
  it("accepts a template based document", () => {
    expect(newDocumentSchema.safeParse(valid).success).toBe(true);
  });

  it("trims the title", () => {
    const result = newDocumentSchema.parse({ ...valid, title: "  Plan  " });
    expect(result.title).toBe("Plan");
  });

  it.each([
    [{ categoryId: "" }, tr.newDocument.validation.categoryRequired],
    [{ departmentId: "" }, tr.newDocument.validation.departmentRequired],
    [{ title: "" }, tr.newDocument.validation.titleRequired],
    [{ title: "   " }, tr.newDocument.validation.titleRequired],
    [{ title: "ab" }, tr.newDocument.validation.titleTooShort],
    [{ title: "x".repeat(201) }, tr.newDocument.validation.titleTooLong],
  ])("reports %j", (override, message) => {
    expect(messages({ ...valid, ...override })).toContain(message);
  });

  it("does not look at the file for a template based document", () => {
    expect(newDocumentSchema.safeParse({ ...valid, file: fileOfSize("x.txt", 5) }).success).toBe(true);
  });

  describe("upload", () => {
    const upload = { ...valid, source: "upload" as const };

    it("accepts a supported file", () => {
      expect(newDocumentSchema.safeParse({ ...upload, file: fileOfSize("a.docx", 10) }).success).toBe(true);
      expect(newDocumentSchema.safeParse({ ...upload, file: fileOfSize("a.xlsx", 10) }).success).toBe(true);
    });

    it("requires a file", () => {
      expect(messages(upload)).toContain(tr.newDocument.validation.fileRequired);
    });

    it("rejects an unsupported extension", () => {
      expect(messages({ ...upload, file: fileOfSize("a.pdf", 10) })).toContain(
        tr.newDocument.validation.fileTypeUnsupported,
      );
    });

    it("rejects an empty file", () => {
      expect(messages({ ...upload, file: fileOfSize("a.docx", 0) })).toContain(tr.newDocument.validation.fileEmpty);
    });

    it("rejects a file above the limit but accepts one exactly at it", () => {
      expect(messages({ ...upload, file: fileOfSize("a.docx", MAX_UPLOAD_BYTES + 1) })).toContain(
        tr.newDocument.validation.fileTooLarge(25),
      );
      expect(newDocumentSchema.safeParse({ ...upload, file: fileOfSize("a.docx", MAX_UPLOAD_BYTES) }).success).toBe(true);
    });
  });
});
