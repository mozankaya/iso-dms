"use client";

import { DEFAULT_MAX_UPLOAD_MB, ORGANIZATION_NAME_MAX_LENGTH, ORGANIZATION_NAME_MIN_LENGTH, type AdminTemplateDto } from "@iso-dms/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import { createTemplate, deleteTemplate, getAdminTemplates, getCategories, replaceTemplateFile, templateDownloadPath, updateTemplate } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/auth-context";
import { canAdminister } from "@/lib/auth/permissions";
import { downloadFromApi } from "@/lib/download";
import { fileTypeOf, MAX_UPLOAD_BYTES, titleFromFileName } from "@/lib/documents/new-document-schema";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.admin.templates;
const common = tr.admin.common;
const fileMessages = tr.newDocument.validation;

/** The new-document screen, the template pickers and the audit trail all follow a change made here. */
async function refreshTemplates(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all(["admin-templates", "templates", "audit-logs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
}

/** What is wrong with a chosen file, in Turkish; null when it is fine. The API checks the content again. */
function fileProblem(file: File | null): string | null {
  if (!file) return fileMessages.fileRequired;
  if (!fileTypeOf(file.name)) return fileMessages.fileTypeUnsupported;
  if (file.size === 0) return fileMessages.fileEmpty;
  if (file.size > MAX_UPLOAD_BYTES) return fileMessages.fileTooLarge(DEFAULT_MAX_UPLOAD_MB);
  return null;
}

function Actions({ buttons }: { buttons: { label: string; ariaLabel: string; onClick: () => void; destructive?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {buttons.map((button) => (
        <Button key={button.label} variant="outline" size="sm" onClick={button.onClick} aria-label={button.ariaLabel} className={button.destructive ? "text-destructive" : undefined}>
          {button.label}
        </Button>
      ))}
    </div>
  );
}

function FormButtons({ pending, onClose, submitLabel }: { pending: boolean; onClose: () => void; submitLabel?: string }) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" onClick={onClose} disabled={pending}>
        {common.cancel}
      </Button>
      <Button type="submit" disabled={pending}>
        {pending ? common.saving : (submitLabel ?? common.save)}
      </Button>
    </div>
  );
}

function ServerError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

const errorText = (caught: unknown) => (caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);

function TemplateForm({ template, onClose }: { template: AdminTemplateDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const ids = { name: useId(), category: useId(), file: useId(), isDefault: useId() };
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(template?.name ?? "");
  const [categoryId, setCategoryId] = useState(template?.category?.id ?? "");
  const [isDefault, setIsDefault] = useState(template?.isDefault ?? false);
  const [file, setFile] = useState<File | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categories = useQuery({ queryKey: ["categories"], queryFn: getCategories });

  const trimmedName = name.trim();
  const nameInvalid = trimmedName.length < ORGANIZATION_NAME_MIN_LENGTH || trimmedName.length > ORGANIZATION_NAME_MAX_LENGTH;
  const problem = template ? null : fileProblem(file);

  const save = useMutation({
    mutationFn: () =>
      template
        ? updateTemplate(template.id, { name: trimmedName, categoryId: categoryId || null, isDefault })
        : createTemplate({ name: trimmedName, categoryId: categoryId || null, isDefault, file: file! }),
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (nameInvalid || problem) return;
    try {
      await save.mutateAsync();
    } catch (caught) {
      setError(errorText(caught));
      return;
    }
    await refreshTemplates(queryClient);
    onClose();
  }

  function chooseFile(chosen: File | null) {
    setFile(chosen);
    // The name of the file is a good first guess for the name of the template
    if (chosen && !name.trim()) setName(titleFromFileName(chosen.name).slice(0, ORGANIZATION_NAME_MAX_LENGTH));
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {!template && (
        <div className="space-y-1.5">
          <Label htmlFor={ids.file}>{t.file}</Label>
          <input
            ref={fileInput}
            id={ids.file}
            type="file"
            accept=".docx,.xlsx"
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
            aria-invalid={submitted && problem ? true : undefined}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-card file:px-3 file:py-2 file:text-sm"
          />
          {submitted && problem ? <p className="text-sm text-destructive">{problem}</p> : <p className="text-xs text-muted">{t.fileHint}</p>}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={ids.name}>{t.name}</Label>
        <Input id={ids.name} value={name} onChange={(event) => setName(event.target.value)} maxLength={ORGANIZATION_NAME_MAX_LENGTH} aria-invalid={submitted && nameInvalid ? true : undefined} />
        {submitted && nameInvalid && <p className="text-sm text-destructive">{t.validation.nameLength}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={ids.category}>{t.category}</Label>
        <Select id={ids.category} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="">{t.allCategories}</option>
          {categories.data?.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
          {/* The category of the template stays choosable even when it is out of use now */}
          {template?.category && !categories.data?.some((category) => category.id === template.category?.id) && (
            <option value={template.category.id}>{template.category.name}</option>
          )}
        </Select>
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm font-medium" htmlFor={ids.isDefault}>
          <input id={ids.isDefault} type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
          {t.setDefault}
        </label>
        <p className="text-xs text-muted">{t.defaultHint}</p>
      </div>

      <ServerError message={error} />
      <FormButtons pending={save.isPending} onClose={onClose} />
    </form>
  );
}

function ReplaceForm({ template, onClose }: { template: AdminTemplateDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replace = useMutation({ mutationFn: () => replaceTemplateFile(template.id, file!) });
  const problem = fileProblem(file) ?? (file && fileTypeOf(file.name) !== template.fileType ? fileMessages.fileTypeUnsupported : null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (problem) return;
    try {
      await replace.mutateAsync();
    } catch (caught) {
      setError(errorText(caught));
      return;
    }
    await refreshTemplates(queryClient);
    onClose();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm">{t.replaceIntro(template.name, t.fileTypes[template.fileType])}</p>
      <div className="space-y-1.5">
        <Label htmlFor={fileId}>{t.file}</Label>
        <input
          id={fileId}
          type="file"
          accept={template.fileType === "DOCX" ? ".docx" : ".xlsx"}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          aria-invalid={submitted && problem ? true : undefined}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-card file:px-3 file:py-2 file:text-sm"
        />
        {submitted && problem && <p className="text-sm text-destructive">{problem}</p>}
      </div>
      <ServerError message={error} />
      <FormButtons pending={replace.isPending} onClose={onClose} />
    </form>
  );
}

function DeleteForm({ template, onClose }: { template: AdminTemplateDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({ mutationFn: () => deleteTemplate(template.id) });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await remove.mutateAsync();
    } catch (caught) {
      setError(errorText(caught));
      return;
    }
    await refreshTemplates(queryClient);
    onClose();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm">{t.deleteConfirm(template.name)}</p>
      <ServerError message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={remove.isPending}>
          {common.cancel}
        </Button>
        <Button type="submit" variant="destructive" disabled={remove.isPending}>
          {remove.isPending ? common.saving : t.delete}
        </Button>
      </div>
    </form>
  );
}

/** Templates new documents start from: add, edit, replace the file, download, delete (PROJECT.md 6.11). */
export function TemplateAdmin() {
  const { user } = useAuth();
  const allowed = canAdminister(user?.role);
  // `false` is the closed state, `null` is "a new template", a row is "edit this one"
  const [editing, setEditing] = useState<AdminTemplateDto | null | false>(false);
  const [replacing, setReplacing] = useState<AdminTemplateDto | null>(null);
  const [deleting, setDeleting] = useState<AdminTemplateDto | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const templates = useQuery({ queryKey: ["admin-templates"], queryFn: getAdminTemplates, enabled: allowed });

  async function download(template: AdminTemplateDto) {
    setDownloadError(null);
    try {
      await downloadFromApi(templateDownloadPath(template.id), `${template.name}.${template.fileType.toLowerCase()}`);
    } catch (caught) {
      setDownloadError(errorText(caught));
    }
  }

  if (!allowed) return <p className="text-muted">{common.forbidden}</p>;
  if (templates.isPending) return <p className="text-muted">{tr.common.loading}</p>;
  if (templates.isError) {
    return (
      <p role="alert" className="text-destructive">
        {common.loadError}
      </p>
    );
  }

  const rows = templates.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">{t.total(rows.length)}</p>
        <Button onClick={() => setEditing(null)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          {t.add}
        </Button>
      </div>
      <ServerError message={downloadError} />
      <p className="text-xs text-muted">{t.fieldsHelp}</p>

      {rows.length === 0 ? (
        <p className="text-muted">{t.empty}</p>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={t.tableLabel}>
            <thead className="border-b border-border text-left text-muted">
              <tr>
                {(["name", "type", "category", "fields", "isDefault", "actions"] as const).map((column) => (
                  <th key={column} scope="col" className="px-4 py-2 font-medium whitespace-nowrap">
                    {t.columns[column]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">{row.name}</td>
                  <td className="px-4 py-2">{t.fileTypes[row.fileType]}</td>
                  <td className="px-4 py-2">{row.category?.name ?? <span className="text-muted">{t.allCategories}</span>}</td>
                  <td className="px-4 py-2">
                    {row.fields.length > 0 ? row.fields.map((field) => t.fieldLabels[field]).join(", ") : <span className="text-muted">{t.noFields}</span>}
                  </td>
                  <td className="px-4 py-2">{row.isDefault && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">{t.defaultBadge}</span>}</td>
                  <td className="px-4 py-2">
                    <Actions
                      buttons={[
                        { label: common.edit, ariaLabel: `${common.edit}: ${row.name}`, onClick: () => setEditing(row) },
                        { label: t.replaceFile, ariaLabel: `${t.replaceFile}: ${row.name}`, onClick: () => setReplacing(row) },
                        { label: t.download, ariaLabel: `${t.download}: ${row.name}`, onClick: () => download(row) },
                        { label: t.delete, ariaLabel: `${t.delete}: ${row.name}`, onClick: () => setDeleting(row), destructive: true },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal open={editing !== false} onClose={() => setEditing(false)} title={editing ? t.editTitle : t.createTitle}>
        {editing !== false && <TemplateForm key={editing?.id ?? "new"} template={editing} onClose={() => setEditing(false)} />}
      </Modal>
      <Modal open={replacing !== null} onClose={() => setReplacing(null)} title={t.replaceTitle}>
        {replacing && <ReplaceForm key={replacing.id} template={replacing} onClose={() => setReplacing(null)} />}
      </Modal>
      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title={t.deleteTitle}>
        {deleting && <DeleteForm key={deleting.id} template={deleting} onClose={() => setDeleting(null)} />}
      </Modal>
    </div>
  );
}
