"use client";

import {
  CATEGORY_DESCRIPTION_MAX_LENGTH,
  CATEGORY_ICONS,
  CATEGORY_PREFIX_PATTERN,
  CATEGORY_SORT_ORDER_MAX,
  CATEGORY_URL_MAX_LENGTH,
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_NAME_MIN_LENGTH,
  type AdminCategoryDto,
} from "@iso-dms/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ActiveBadge } from "@/components/admin/department-admin";
import { ToggleActiveDialog } from "@/components/admin/toggle-active-dialog";
import { CategoryIcon } from "@/components/category-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import { createCategory, getAdminCategories, updateCategory } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/auth-context";
import { canAdminister } from "@/lib/auth/permissions";
import { errorMessage, tr } from "@/lib/i18n/tr";
import { cn } from "@/lib/utils";

const t = tr.admin.categories;
const common = tr.admin.common;

/** The menu, the dashboard and the pickers all follow a change made here. */
async function refreshCategories(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all(["admin-categories", "categories", "audit-logs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function CategoryForm({ category, onClose }: { category: AdminCategoryDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const ids = { name: useId(), prefix: useId(), description: useId(), icon: useId(), sortOrder: useId(), external: useId(), url: useId() };
  const [name, setName] = useState(category?.name ?? "");
  const [prefix, setPrefix] = useState("");
  const [description, setDescription] = useState(category?.description ?? "");
  const [icon, setIcon] = useState(category?.icon ?? "");
  const [sortOrder, setSortOrder] = useState(category ? String(category.sortOrder) : "");
  const [isExternal, setIsExternal] = useState(category?.isExternal ?? false);
  const [externalUrl, setExternalUrl] = useState(category?.externalUrl ?? "");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const trimmedUrl = externalUrl.trim();
  const sortOrderNumber = sortOrder.trim() === "" ? null : Number(sortOrder);
  const invalid = {
    name: trimmedName.length < ORGANIZATION_NAME_MIN_LENGTH || trimmedName.length > ORGANIZATION_NAME_MAX_LENGTH,
    prefix: !category && !CATEGORY_PREFIX_PATTERN.test(prefix.trim().toUpperCase()),
    url: isExternal && trimmedUrl !== "" && !isHttpUrl(trimmedUrl),
    sortOrder: sortOrderNumber !== null && (!Number.isInteger(sortOrderNumber) || sortOrderNumber < 0 || sortOrderNumber > CATEGORY_SORT_ORDER_MAX),
  };

  const save = useMutation({
    mutationFn: () => {
      const common = {
        name: trimmedName,
        description: description.trim() || null,
        icon: icon || null,
        externalUrl: isExternal ? trimmedUrl || null : undefined,
      };
      if (category) return updateCategory(category.id, { ...common, ...(sortOrderNumber !== null && { sortOrder: sortOrderNumber }) });
      return createCategory({ ...common, codePrefix: prefix.trim().toUpperCase(), isExternal, ...(sortOrderNumber !== null && { sortOrder: sortOrderNumber }) });
    },
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (Object.values(invalid).some(Boolean)) return;
    try {
      await save.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    await refreshCategories(queryClient);
    onClose();
  }

  const show = (flag: boolean) => (submitted && flag ? true : undefined);

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor={ids.name}>{common.name}</Label>
        <Input id={ids.name} value={name} onChange={(event) => setName(event.target.value)} maxLength={ORGANIZATION_NAME_MAX_LENGTH} aria-invalid={show(invalid.name)} />
        {show(invalid.name) && <p className="text-sm text-destructive">{t.validation.nameLength}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={ids.prefix}>{t.prefix}</Label>
        {category ? (
          <>
            <Input id={ids.prefix} value={category.codePrefix} disabled readOnly />
            <p className="text-xs text-muted">{common.codeImmutable}</p>
          </>
        ) : (
          <>
            <Input id={ids.prefix} value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder={t.prefixHint} maxLength={3} className="uppercase" aria-invalid={show(invalid.prefix)} />
            {show(invalid.prefix) ? <p className="text-sm text-destructive">{t.validation.prefixFormat}</p> : <p className="text-xs text-muted">{common.codeImmutable}</p>}
          </>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={ids.description}>{t.descriptionLabel}</Label>
        <Input id={ids.description} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={CATEGORY_DESCRIPTION_MAX_LENGTH} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={ids.icon}>{t.icon}</Label>
          <Select id={ids.icon} value={icon} onChange={(event) => setIcon(event.target.value)}>
            <option value="">{t.icons.folder}</option>
            {CATEGORY_ICONS.filter((name) => name !== "folder").map((name) => (
              <option key={name} value={name}>
                {t.icons[name]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.sortOrder}>{t.sortOrder}</Label>
          <Input id={ids.sortOrder} inputMode="numeric" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} aria-invalid={show(invalid.sortOrder)} />
        </div>
      </div>
      {show(invalid.sortOrder) ? <p className="-mt-2 text-sm text-destructive">{t.validation.sortOrderRange}</p> : !category && <p className="-mt-2 text-xs text-muted">{t.sortOrderHint}</p>}

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium" htmlFor={ids.external}>
          <input id={ids.external} type="checkbox" checked={isExternal} disabled={category !== null} onChange={(event) => setIsExternal(event.target.checked)} />
          {t.isExternal}
        </label>
        {!category && <p className="text-xs text-muted">{t.isExternalHint}</p>}
        {isExternal && (
          <div className="space-y-1.5">
            <Label htmlFor={ids.url}>{t.externalUrl}</Label>
            <Input id={ids.url} value={externalUrl} onChange={(event) => setExternalUrl(event.target.value)} placeholder={t.externalUrlHint} maxLength={CATEGORY_URL_MAX_LENGTH} aria-invalid={show(invalid.url)} />
            {show(invalid.url) && <p className="text-sm text-destructive">{t.validation.urlFormat}</p>}
          </div>
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

/** Categories of the organization: add, edit, take out of use (PROJECT.md 6.9). */
export function CategoryAdmin() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const allowed = canAdminister(user?.role);
  // `false` is the closed state, `null` is "a new category", a row is "edit this one"
  const [editing, setEditing] = useState<AdminCategoryDto | null | false>(false);
  const [toggling, setToggling] = useState<AdminCategoryDto | null>(null);
  const categories = useQuery({ queryKey: ["admin-categories"], queryFn: getAdminCategories, enabled: allowed });

  if (!allowed) return <p className="text-muted">{common.forbidden}</p>;
  if (categories.isPending) return <p className="text-muted">{tr.common.loading}</p>;
  if (categories.isError) return <p role="alert" className="text-destructive">{common.loadError}</p>;

  const rows = categories.data;

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
                <th className="px-4 py-2 font-medium">{t.sortOrder}</th>
                <th className="px-4 py-2 font-medium">{t.prefix}</th>
                <th className="px-4 py-2 font-medium">{common.name}</th>
                <th className="px-4 py-2 font-medium">{common.documents}</th>
                <th className="px-4 py-2 font-medium">{common.status}</th>
                <th className="px-4 py-2 font-medium">{common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">{row.sortOrder}</td>
                  <td className="px-4 py-2 font-mono">{row.codePrefix}</td>
                  <td className={cn("px-4 py-2", !row.isActive && "text-muted")}>
                    <span className="flex items-center gap-2">
                      <CategoryIcon name={row.icon} className="h-4 w-4 shrink-0" />
                      <span>
                        {row.name}
                        {row.isExternal && <span className="ml-2 text-xs text-muted">({tr.admin.categories.isExternal.toLocaleLowerCase("tr-TR")})</span>}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-2">{row.documentCount}</td>
                  <td className="px-4 py-2">
                    <ActiveBadge active={row.isActive} />
                  </td>
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
        {editing !== false && <CategoryForm key={editing?.id ?? "new"} category={editing} onClose={() => setEditing(false)} />}
      </Modal>

      <ToggleActiveDialog
        target={toggling}
        titles={{ deactivate: t.deactivateTitle, activate: t.activateTitle }}
        messageFor={(row) => (row.isActive ? t.deactivateConfirm(row.name, row.documentCount) : t.activateConfirm(row.name))}
        run={(row) => updateCategory(row.id, { isActive: !row.isActive })}
        onDone={() => refreshCategories(queryClient)}
        onClose={() => setToggling(null)}
      />
    </div>
  );
}
