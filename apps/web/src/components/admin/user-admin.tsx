"use client";

import {
  DEFAULT_PAGE_SIZE,
  DEPARTMENT_REQUIRED_ROLES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USER_NAME_MAX_LENGTH,
  USER_NAME_MIN_LENGTH,
  USER_ROLES,
  USER_STATUS_FILTERS,
  type AdminUserDto,
  type UserRole,
  type UserWithPasswordDto,
} from "@iso-dms/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { ActiveBadge } from "@/components/admin/department-admin";
import { ToggleActiveDialog } from "@/components/admin/toggle-active-dialog";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import { createUser, getAdminUsers, getDepartments, resetUserPassword, updateUser } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/auth-context";
import { canAdminister } from "@/lib/auth/permissions";
import { formatDateTime } from "@/lib/format";
import { errorMessage, tr } from "@/lib/i18n/tr";
import { hasActiveUserFilters, parseUserParams, toUserQuery, toUserSearchString, type UserListParams } from "@/lib/users/list-params";
import { cn } from "@/lib/utils";

const t = tr.admin.users;
const common = tr.admin.common;
const SEARCH_DEBOUNCE_MS = 300;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The list, the department user counts and the audit trail all follow a change made here. */
async function refreshUsers(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all(["admin-users", "admin-departments", "audit-logs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
}

function UserForm({ user, onClose, onSaved }: { user: AdminUserDto | null; onClose: () => void; onSaved: (result: UserWithPasswordDto | null, name: string) => void }) {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const ids = { name: useId(), email: useId(), role: useId(), department: useId(), password: useId() };
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>(user?.role ?? "READER");
  const [departmentId, setDepartmentId] = useState(user?.department?.id ?? "");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const departments = useQuery({ queryKey: ["departments"], queryFn: getDepartments });
  const own = user !== null && user.id === me?.id;

  const trimmedName = fullName.trim();
  const needsDepartment = DEPARTMENT_REQUIRED_ROLES.includes(role);
  const invalid = {
    name: trimmedName.length < USER_NAME_MIN_LENGTH || trimmedName.length > USER_NAME_MAX_LENGTH,
    email: !user && !EMAIL_PATTERN.test(email.trim()),
    department: needsDepartment && !departmentId,
    password: !user && password !== "" && (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH),
  };

  const save = useMutation({
    mutationFn: async (): Promise<UserWithPasswordDto | null> => {
      if (user) {
        await updateUser(user.id, { fullName: trimmedName, role, departmentId: departmentId || null });
        return null;
      }
      return createUser({ fullName: trimmedName, email: email.trim(), role, departmentId: departmentId || null, ...(password && { password }) });
    },
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (Object.values(invalid).some(Boolean)) return;
    let result: UserWithPasswordDto | null;
    try {
      result = await save.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    await refreshUsers(queryClient);
    onSaved(result, trimmedName);
  }

  const show = (flag: boolean) => (submitted && flag ? true : undefined);

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor={ids.name}>{t.fullName}</Label>
        <Input id={ids.name} value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={USER_NAME_MAX_LENGTH} aria-invalid={show(invalid.name)} />
        {show(invalid.name) && <p className="text-sm text-destructive">{t.validation.nameLength}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={ids.email}>{t.email}</Label>
        {user ? (
          <>
            <Input id={ids.email} value={user.email} disabled readOnly />
            <p className="text-xs text-muted">{t.emailImmutable}</p>
          </>
        ) : (
          <>
            <Input id={ids.email} type="email" value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={show(invalid.email)} />
            {show(invalid.email) ? <p className="text-sm text-destructive">{t.validation.emailInvalid}</p> : <p className="text-xs text-muted">{t.emailImmutable}</p>}
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={ids.role}>{t.role}</Label>
          <Select id={ids.role} value={role} disabled={own} onChange={(event) => setRole(event.target.value as UserRole)}>
            {USER_ROLES.map((value) => (
              <option key={value} value={value}>
                {t.roles[value]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.department}>{t.department}</Label>
          <Select id={ids.department} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} aria-invalid={show(invalid.department)}>
            <option value="">{t.departmentNone}</option>
            {departments.data?.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
            {/* The department of the user stays choosable even when it is out of use now */}
            {user?.department && !departments.data?.some((department) => department.id === user.department?.id) && (
              <option value={user.department.id}>{user.department.name}</option>
            )}
          </Select>
        </div>
      </div>
      {show(invalid.department) ? <p className="-mt-2 text-sm text-destructive">{t.validation.departmentRequired}</p> : <p className="-mt-2 text-xs text-muted">{t.departmentRequiredHint}</p>}
      {own && <p className="-mt-2 text-xs text-muted">{t.ownAccountHint}</p>}

      {!user && (
        <div className="space-y-1.5">
          <Label htmlFor={ids.password}>{t.password}</Label>
          <Input id={ids.password} type="text" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={show(invalid.password)} />
          {show(invalid.password) ? <p className="text-sm text-destructive">{t.validation.passwordLength}</p> : <p className="text-xs text-muted">{t.passwordHint}</p>}
        </div>
      )}

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

function ResetForm({ user, onClose, onDone }: { user: AdminUserDto; onClose: () => void; onDone: (result: UserWithPasswordDto) => void }) {
  const queryClient = useQueryClient();
  const passwordId = useId();
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = useMutation({ mutationFn: () => resetUserPassword(user.id, password ? { password } : {}) });
  const invalid = password !== "" && (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (invalid) return;
    let result: UserWithPasswordDto;
    try {
      result = await reset.mutateAsync();
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    await refreshUsers(queryClient);
    onDone(result);
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm">{t.resetConfirm(user.fullName)}</p>
      <div className="space-y-1.5">
        <Label htmlFor={passwordId}>{t.password}</Label>
        <Input id={passwordId} type="text" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={submitted && invalid ? true : undefined} />
        {submitted && invalid ? <p className="text-sm text-destructive">{t.validation.passwordLength}</p> : <p className="text-xs text-muted">{t.passwordHint}</p>}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={reset.isPending}>
          {common.cancel}
        </Button>
        <Button type="submit" variant="destructive" disabled={reset.isPending}>
          {reset.isPending ? common.saving : t.resetPassword}
        </Button>
      </div>
    </form>
  );
}

interface ShownPassword {
  title: string;
  name: string;
  temporaryPassword: string | null;
}

/** The only time a generated password is visible: it is not stored anywhere in the clear. */
function PasswordShown({ shown, onClose }: { shown: ShownPassword | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown?.temporaryPassword ?? "");
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const text = tr.admin.users.passwordShown;

  return (
    <Modal open={shown !== null} onClose={onClose} title={shown?.title ?? ""}>
      {shown && (
        <div className="space-y-4">
          {shown.temporaryPassword ? (
            <>
              <p className="text-sm">{text.intro(shown.name)}</p>
              <div className="space-y-1.5">
                <Label>{text.label}</Label>
                <div className="flex gap-2">
                  <code aria-label={text.label} className="flex-1 rounded-md border border-border bg-accent px-3 py-2 font-mono text-sm break-all select-all">
                    {shown.temporaryPassword}
                  </code>
                  <Button variant="outline" onClick={copy}>
                    {copied ? text.copied : text.copy}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm">{text.chosen(shown.name)}</p>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose}>{text.close}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Users of the organization: add, edit, reset the password, take out of use (PROJECT.md 6.10). */
export function UserAdmin() {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const allowed = canAdminister(me?.role);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useMemo(() => parseUserParams(searchParams), [searchParams]);

  const [searchText, setSearchText] = useState(params.q);
  // `false` is the closed state, `null` is "a new user", a row is "edit this one"
  const [editing, setEditing] = useState<AdminUserDto | null | false>(false);
  const [toggling, setToggling] = useState<AdminUserDto | null>(null);
  const [resetting, setResetting] = useState<AdminUserDto | null>(null);
  const [shown, setShown] = useState<ShownPassword | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  function update(patch: Partial<UserListParams>) {
    router.replace(`${pathname}${toUserSearchString({ ...params, page: 1, ...patch })}`, { scroll: false });
  }

  function onSearchChange(value: string) {
    setSearchText(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => update({ q: value.trim() }), SEARCH_DEBOUNCE_MS);
  }

  function clearFilters() {
    clearTimeout(debounceTimer.current);
    setSearchText("");
    update({ q: "", role: "", department: "", status: "all" });
  }

  const departments = useQuery({ queryKey: ["departments"], queryFn: getDepartments, enabled: allowed });
  const users = useQuery({ queryKey: ["admin-users", params], queryFn: () => getAdminUsers(toUserQuery(params)), placeholderData: keepPreviousData, enabled: allowed });

  const totalPages = users.data ? Math.max(1, Math.ceil(users.data.total / DEFAULT_PAGE_SIZE)) : 1;
  const pastLastPage = users.data && !users.isPlaceholderData && params.page > totalPages;
  useEffect(() => {
    if (pastLastPage) router.replace(`${pathname}${toUserSearchString({ ...params, page: totalPages })}`, { scroll: false });
  }, [pastLastPage, params, totalPages, pathname, router]);

  if (!allowed) return <p className="text-muted">{common.forbidden}</p>;

  const filtered = hasActiveUserFilters(params);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="user-search">{t.searchLabel}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input id="user-search" type="search" className="pl-9" placeholder={t.searchPlaceholder} value={searchText} onChange={(event) => onSearchChange(event.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="user-role">{t.roleFilter}</Label>
          <Select id="user-role" value={params.role} onChange={(event) => update({ role: event.target.value as UserListParams["role"] })}>
            <option value="">{t.allRoles}</option>
            {USER_ROLES.map((role) => (
              <option key={role} value={role}>
                {t.roles[role]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="user-department">{t.departmentFilter}</Label>
          <Select id="user-department" value={params.department} onChange={(event) => update({ department: event.target.value })}>
            <option value="">{t.allDepartments}</option>
            {departments.data?.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="user-status">{t.statusFilter}</Label>
          <Select id="user-status" value={params.status} onChange={(event) => update({ status: event.target.value as UserListParams["status"] })}>
            {USER_STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {t.statuses[status]}
              </option>
            ))}
          </Select>
        </div>
        {filtered && (
          <Button variant="ghost" onClick={clearFilters}>
            {t.clearFilters}
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">{users.data ? t.total(users.data.total) : ""}</p>
        <Button onClick={() => setEditing(null)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          {t.add}
        </Button>
      </div>

      {users.isPending && (
        <p className="text-muted" role="status">
          {tr.common.loading}
        </p>
      )}
      {users.isError && !users.data && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{common.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => users.refetch()}>
            {tr.common.retry}
          </Button>
        </div>
      )}
      {users.data && users.data.total === 0 && <p className="py-8 text-center text-muted">{filtered ? t.emptyFiltered : t.empty}</p>}

      {users.data && users.data.total > 0 && (
        <div className={cn("space-y-4", users.isPlaceholderData && "opacity-60 transition-opacity")}>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={t.tableLabel}>
              <thead className="border-b border-border text-left text-muted">
                <tr>
                  {(["name", "email", "role", "department", "status", "lastLogin", "actions"] as const).map((column) => (
                    <th key={column} scope="col" className="px-4 py-2 font-medium whitespace-nowrap">
                      {t.columns[column]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((row) => {
                  const own = row.id === me?.id;
                  return (
                    <tr key={row.id} className="border-b border-border last:border-0">
                      <td className={cn("px-4 py-2", !row.isActive && "text-muted")}>{row.fullName}</td>
                      <td className="px-4 py-2 break-all">{row.email}</td>
                      <td className="px-4 py-2 whitespace-nowrap">{t.roles[row.role]}</td>
                      <td className="px-4 py-2">{row.department?.name ?? <span className="text-muted">{t.noDepartment}</span>}</td>
                      <td className="px-4 py-2">
                        <span className="flex flex-wrap items-center gap-1">
                          <ActiveBadge active={row.isActive} />
                          {row.mustChangePassword && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">{t.mustChange}</span>}
                        </span>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">{row.lastLoginAt ? formatDateTime(row.lastLoginAt) : <span className="text-muted">{t.neverSignedIn}</span>}</td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" size="sm" onClick={() => setEditing(row)} aria-label={`${common.edit}: ${row.fullName}`}>
                            {common.edit}
                          </Button>
                          {!own && (
                            <>
                              <Button variant="outline" size="sm" onClick={() => setResetting(row)} aria-label={`${t.resetPassword}: ${row.fullName}`}>
                                {t.resetPassword}
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => setToggling(row)} aria-label={`${row.isActive ? common.deactivate : common.activate}: ${row.fullName}`}>
                                {row.isActive ? common.deactivate : common.activate}
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          {totalPages > 1 && <Pagination page={params.page} totalPages={totalPages} onPageChange={(page) => update({ page })} />}
        </div>
      )}

      <Modal open={editing !== false} onClose={() => setEditing(false)} title={editing ? t.editTitle : t.createTitle}>
        {editing !== false && (
          <UserForm
            key={editing?.id ?? "new"}
            user={editing}
            onClose={() => setEditing(false)}
            onSaved={(result, name) => {
              setEditing(false);
              if (result) setShown({ title: t.passwordShown.titleCreated, name, temporaryPassword: result.temporaryPassword });
            }}
          />
        )}
      </Modal>

      <Modal open={resetting !== null} onClose={() => setResetting(null)} title={t.resetTitle}>
        {resetting && (
          <ResetForm
            key={resetting.id}
            user={resetting}
            onClose={() => setResetting(null)}
            onDone={(result) => {
              setShown({ title: t.passwordShown.titleReset, name: resetting.fullName, temporaryPassword: result.temporaryPassword });
              setResetting(null);
            }}
          />
        )}
      </Modal>

      <PasswordShown shown={shown} onClose={() => setShown(null)} />

      <ToggleActiveDialog
        target={toggling}
        titles={{ deactivate: t.deactivateTitle, activate: t.activateTitle }}
        messageFor={(row) => (row.isActive ? t.deactivateConfirm(row.fullName) : t.activateConfirm(row.fullName))}
        run={(row) => updateUser(row.id, { isActive: !row.isActive })}
        onDone={() => refreshUsers(queryClient)}
        onClose={() => setToggling(null)}
      />
    </div>
  );
}
