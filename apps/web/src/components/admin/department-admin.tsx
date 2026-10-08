"use client";

import { DEPARTMENT_CODE_PATTERN, ORGANIZATION_NAME_MAX_LENGTH, ORGANIZATION_NAME_MIN_LENGTH, type AdminDepartmentDto } from "@iso-dms/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ToggleActiveDialog } from "@/components/admin/toggle-active-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { ApiError } from "@/lib/api/client";
import { createDepartment, getAdminDepartments, updateDepartment } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/auth-context";
import { canAdminister } from "@/lib/auth/permissions";
import { formatDate } from "@/lib/format";
import { errorMessage, tr } from "@/lib/i18n/tr";
import { cn } from "@/lib/utils";

const t = tr.admin.departments;
const common = tr.admin.common;

/** Every list that shows departments follows a change made here. */
async function refreshDepartments(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all(["admin-departments", "departments", "audit-logs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
}

export function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-medium", active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700")}>
      {active ? common.active : common.inactive}
    </span>
  );
}

function DepartmentForm({ department, onClose }: { department: AdminDepartmentDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const nameId = useId();
  const codeId = useId();
  const [name, setName] = useState(department?.name ?? "");
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => (department ? updateDepartment(department.id, { name: name.trim() }) : createDepartment({ name: name.trim(), code: code.trim().toUpperCase() })),
  });

  const trimmedName = name.trim();
  const nameInvalid = trimmedName.length < ORGANIZATION_NAME_MIN_LENGTH || trimmedName.length > ORGANIZATION_NAME_MAX_LENGTH;
  const codeInvalid = !department && !DEPARTMENT_CODE_PATTERN.test(code.trim().toUpperCase());

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (nameInvalid || codeInvalid) return;
    try {
      await save.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    await refreshDepartments(queryClient);
    onClose();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>{common.name}</Label>
        <Input id={nameId} value={name} onChange={(event) => setName(event.target.value)} placeholder={t.nameHint} maxLength={ORGANIZATION_NAME_MAX_LENGTH} aria-invalid={submitted && nameInvalid ? true : undefined} />
        {submitted && nameInvalid && <p className="text-sm text-destructive">{t.validation.nameLength}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={codeId}>{t.code}</Label>
        {department ? (
          <>
            <Input id={codeId} value={department.code} disabled readOnly />
            <p className="text-xs text-muted">{common.codeImmutable}</p>
          </>
        ) : (
          <>
            <Input id={codeId} value={code} onChange={(event) => setCode(event.target.value)} placeholder={t.codeHint} maxLength={4} className="uppercase" aria-invalid={submitted && codeInvalid ? true : undefined} />
            {submitted && codeInvalid ? <p className="text-sm text-destructive">{t.validation.codeFormat}</p> : <p className="text-xs text-muted">{common.codeImmutable}</p>}
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>
          {common.cancel}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? common.saving : common.save}
        </Button>
      </div>
    </form>
  );
}

/** Departments of the organization: add, rename, take out of use (PROJECT.md 6.9). */
export function DepartmentAdmin() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const allowed = canAdminister(user?.role);
  // `false` is the closed state, `null` is "a new department", a row is "edit this one"
  const [editing, setEditing] = useState<AdminDepartmentDto | null | false>(false);
  const [toggling, setToggling] = useState<AdminDepartmentDto | null>(null);
  const departments = useQuery({ queryKey: ["admin-departments"], queryFn: getAdminDepartments, enabled: allowed });

  if (!allowed) return <p className="text-muted">{common.forbidden}</p>;
  if (departments.isPending) return <p className="text-muted">{tr.common.loading}</p>;
  if (departments.isError) return <p role="alert" className="text-destructive">{common.loadError}</p>;

  const rows = departments.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">{t.total(rows.length)}</p>
        <Button onClick={() => setEditing(null)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          {t.add}
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted">{t.empty}</p>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={t.tableLabel}>
            <thead className="border-b border-border text-left text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{t.code}</th>
                <th className="px-4 py-2 font-medium">{common.name}</th>
                <th className="px-4 py-2 font-medium">{t.users}</th>
                <th className="px-4 py-2 font-medium">{common.documents}</th>
                <th className="px-4 py-2 font-medium">{common.status}</th>
                <th className="px-4 py-2 font-medium">{common.createdAt}</th>
                <th className="px-4 py-2 font-medium">{common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-mono">{row.code}</td>
                  <td className={cn("px-4 py-2", !row.isActive && "text-muted")}>{row.name}</td>
                  <td className="px-4 py-2">{row.userCount}</td>
                  <td className="px-4 py-2">{row.documentCount}</td>
                  <td className="px-4 py-2">
                    <ActiveBadge active={row.isActive} />
                  </td>
                  <td className="px-4 py-2">{formatDate(row.createdAt)}</td>
                  <td className="px-4 py-2">
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditing(row)} aria-label={`${common.edit}: ${row.name}`}>
                        {common.edit}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setToggling(row)} aria-label={`${row.isActive ? common.deactivate : common.activate}: ${row.name}`}>
                        {row.isActive ? common.deactivate : common.activate}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal open={editing !== false} onClose={() => setEditing(false)} title={editing ? t.editTitle : t.createTitle}>
        {editing !== false && <DepartmentForm key={editing?.id ?? "new"} department={editing} onClose={() => setEditing(false)} />}
      </Modal>

      <ToggleActiveDialog
        target={toggling}
        titles={{ deactivate: t.deactivateTitle, activate: t.activateTitle }}
        messageFor={(row) => (row.isActive ? t.deactivateConfirm(row.name) : t.activateConfirm(row.name))}
        run={(row) => updateDepartment(row.id, { isActive: !row.isActive })}
        onDone={() => refreshDepartments(queryClient)}
        onClose={() => setToggling(null)}
      />
    </div>
  );
}
