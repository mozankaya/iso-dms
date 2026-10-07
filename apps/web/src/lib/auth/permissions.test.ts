import { describe, expect, it } from "vitest";
import { canCreateDocuments, canDecideApprovals, canViewAuditLog, isDepartmentBound } from "./permissions";

describe("canCreateDocuments", () => {
  it.each(["EDITOR", "APPROVER", "QUALITY_MANAGER", "ADMIN"] as const)("allows %s", (role) => {
    expect(canCreateDocuments(role)).toBe(true);
  });

  it("denies readers and unknown users", () => {
    expect(canCreateDocuments("READER")).toBe(false);
    expect(canCreateDocuments(undefined)).toBe(false);
  });
});

describe("isDepartmentBound", () => {
  it("binds editors and approvers to their department", () => {
    expect(isDepartmentBound("EDITOR")).toBe(true);
    expect(isDepartmentBound("APPROVER")).toBe(true);
  });

  it("lets quality managers and admins choose any department", () => {
    expect(isDepartmentBound("QUALITY_MANAGER")).toBe(false);
    expect(isDepartmentBound("ADMIN")).toBe(false);
  });
});

describe("canViewAuditLog", () => {
  it.each(["QUALITY_MANAGER", "ADMIN"] as const)("allows %s", (role) => {
    expect(canViewAuditLog(role)).toBe(true);
  });

  it.each(["READER", "EDITOR", "APPROVER", undefined] as const)("denies %s", (role) => {
    expect(canViewAuditLog(role)).toBe(false);
  });
});

describe("canDecideApprovals", () => {
  it.each(["APPROVER", "QUALITY_MANAGER", "ADMIN"] as const)("allows %s", (role) => {
    expect(canDecideApprovals(role)).toBe(true);
  });

  it.each(["READER", "EDITOR", undefined] as const)("denies %s", (role) => {
    expect(canDecideApprovals(role)).toBe(false);
  });
});
