"use client";

import { DEFAULT_MAX_UPLOAD_MB, type CategoryDto, type DepartmentDto, type FileType, type SessionUserDto } from "@iso-dms/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import { createDocument, getTemplates, uploadDocument } from "@/lib/api/endpoints";
import { isDepartmentBound } from "@/lib/auth/permissions";
import {
  fileTypeOf,
  newDocumentSchema,
  titleFromFileName,
  type NewDocumentValues,
} from "@/lib/documents/new-document-schema";
import { errorMessage, tr } from "@/lib/i18n/tr";
import { cn } from "@/lib/utils";

const t = tr.newDocument;
const FILE_TYPE_LABEL: Record<FileType, string> = { DOCX: t.word, XLSX: t.excel };

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function NewDocumentForm({
  user,
  categories,
  departments,
  initialCategoryId,
}: {
  user: SessionUserDto;
  categories: CategoryDto[];
  departments: DepartmentDto[];
  initialCategoryId: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const departmentLocked = isDepartmentBound(user.role);
  const lockedDepartment = departments.find((department) => department.id === user.departmentId);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    control,
    formState: { errors },
  } = useForm<NewDocumentValues>({
    resolver: zodResolver(newDocumentSchema),
    defaultValues: {
      categoryId: initialCategoryId,
      departmentId: departmentLocked ? (lockedDepartment?.id ?? "") : "",
      title: "",
      source: "template",
      fileType: "DOCX",
      templateId: "",
      file: null,
    },
  });

  const source = useWatch({ control, name: "source" });
  const categoryId = useWatch({ control, name: "categoryId" });
  const fileType = useWatch({ control, name: "fileType" });
  const file = useWatch({ control, name: "file" });
  const detectedType = file ? fileTypeOf(file.name) : null;

  const templates = useQuery({
    queryKey: ["templates", categoryId, fileType],
    queryFn: () => getTemplates({ categoryId, fileType }),
    enabled: source === "template" && Boolean(categoryId),
  });

  const create = useMutation({
    mutationFn: (values: NewDocumentValues) =>
      values.source === "upload"
        ? uploadDocument({
            categoryId: values.categoryId,
            departmentId: values.departmentId,
            title: values.title,
            file: values.file!,
          })
        : createDocument({
            categoryId: values.categoryId,
            departmentId: values.departmentId,
            title: values.title,
            fileType: values.fileType,
            templateId: values.templateId || undefined,
          }),
  });

  async function onSubmit(values: NewDocumentValues) {
    setServerError(null);
    try {
      const created = await create.mutateAsync(values);
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      // A new document opens straight in the editor (PROJECT.md 6.2 rule 1)
      router.push(`/documents/${created.id}/edit`);
    } catch (error) {
      setServerError(error instanceof ApiError ? errorMessage(error) : tr.errors.NETWORK);
    }
  }

  const cancelHref = categories.find((category) => category.id === categoryId)
    ? `/categories/${categories.find((category) => category.id === categoryId)!.slug}`
    : "/";

  return (
    <Card className="max-w-2xl p-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="categoryId">{t.category}</Label>
          <Select
            id="categoryId"
            aria-invalid={errors.categoryId ? true : undefined}
            aria-describedby={errors.categoryId ? "categoryId-error" : undefined}
            {...register("categoryId", { onChange: () => setValue("templateId", "") })}
          >
            <option value="">{t.selectCategory}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
          <FieldError id="categoryId-error" message={errors.categoryId?.message} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="departmentId">{t.department}</Label>
          <Select
            id="departmentId"
            disabled={departmentLocked}
            aria-invalid={errors.departmentId ? true : undefined}
            aria-describedby={errors.departmentId ? "departmentId-error" : undefined}
            {...register("departmentId")}
          >
            <option value="">{t.selectDepartment}</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
          {departmentLocked && <p className="text-sm text-muted">{t.departmentLocked}</p>}
          <FieldError id="departmentId-error" message={errors.departmentId?.message} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="title">{t.documentTitle}</Label>
          <Input
            id="title"
            autoComplete="off"
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? "title-error" : undefined}
            {...register("title")}
          />
          <FieldError id="title-error" message={errors.title?.message} />
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t.source}</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" value="template" {...register("source")} />
              {t.fromTemplate}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" value="upload" {...register("source")} />
              {t.fromUpload}
            </label>
          </div>
        </fieldset>

        {source === "template" ? (
          <>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t.fileType}</legend>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {(Object.keys(FILE_TYPE_LABEL) as FileType[]).map((type) => (
                  <label key={type} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      value={type}
                      {...register("fileType", { onChange: () => setValue("templateId", "") })}
                    />
                    {FILE_TYPE_LABEL[type]}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="space-y-1.5">
              <Label htmlFor="templateId">{t.template}</Label>
              <Select id="templateId" {...register("templateId")}>
                <option value="">{t.defaultTemplate}</option>
                {templates.data?.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </Select>
            </div>
          </>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="file">{t.file}</Label>
            <input
              id="file"
              type="file"
              accept=".docx,.xlsx"
              className={cn(
                "block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-card file:px-3 file:py-2 file:text-sm hover:file:bg-accent",
              )}
              aria-invalid={errors.file ? true : undefined}
              aria-describedby={errors.file ? "file-error" : "file-hint"}
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                setValue("file", selected, { shouldValidate: true });
                if (selected && !getValues("title").trim()) {
                  setValue("title", titleFromFileName(selected.name), { shouldValidate: true });
                }
              }}
            />
            <p id="file-hint" className="text-sm text-muted">
              {t.fileHint(DEFAULT_MAX_UPLOAD_MB)}
            </p>
            {detectedType && <p className="text-sm text-muted">{t.detectedType(FILE_TYPE_LABEL[detectedType])}</p>}
            <FieldError id="file-error" message={errors.file?.message} />
          </div>
        )}

        {serverError && (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? t.submitting : t.submit}
          </Button>
          <Link href={cancelHref} className={buttonVariants({ variant: "outline" })}>
            {t.cancel}
          </Link>
        </div>
      </form>
    </Card>
  );
}
