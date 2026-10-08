import { describe, expect, it } from "vitest";
import { DEFAULT_USER_PARAMS, hasActiveUserFilters, parseUserParams, toUserQuery, toUserSearchString } from "./list-params";

const UUID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";
const parse = (query: string) => parseUserParams(new URLSearchParams(query));

describe("parseUserParams", () => {
  it("shows everybody by default", () => {
    expect(parse("")).toEqual(DEFAULT_USER_PARAMS);
  });

  it("reads valid values", () => {
    expect(parse(`q=%20ayşe%20&role=EDITOR&department=${UUID}&status=inactive&page=3`)).toEqual({
      q: "ayşe",
      role: "EDITOR",
      department: UUID,
      status: "inactive",
      page: 3,
    });
  });

  it.each([
    ["an unknown role", "role=GOD", "role"],
    ["a department that is no id", "department=x", "department"],
    ["an unknown status", "status=maybe", "status"],
  ])("ignores %s", (_label, query, key) => {
    expect(parse(query)[key as "role" | "department" | "status"]).toBe(DEFAULT_USER_PARAMS[key as "role" | "department" | "status"]);
  });

  it.each(["0", "-2", "1.5", "abc"])("ignores the page %s", (page) => {
    expect(parse(`page=${page}`).page).toBe(1);
  });
});

describe("toUserSearchString", () => {
  it("writes nothing for the defaults and only what differs otherwise", () => {
    expect(toUserSearchString(DEFAULT_USER_PARAMS)).toBe("");
    expect(toUserSearchString({ ...DEFAULT_USER_PARAMS, role: "READER", page: 2 })).toBe("?role=READER&page=2");
  });

  it("round-trips", () => {
    const params = { q: "ayşe", role: "APPROVER" as const, department: UUID, status: "active" as const, page: 4 };
    expect(parse(toUserSearchString(params).slice(1))).toEqual(params);
  });
});

describe("toUserQuery and hasActiveUserFilters", () => {
  it("leaves out empty filters", () => {
    expect(toUserQuery(DEFAULT_USER_PARAMS)).toEqual({ status: "all", page: 1, pageSize: 20 });
    expect(toUserQuery({ ...DEFAULT_USER_PARAMS, q: "a", role: "EDITOR", department: UUID })).toMatchObject({ search: "a", role: "EDITOR", departmentId: UUID });
  });

  it("knows when a filter is on", () => {
    expect(hasActiveUserFilters(DEFAULT_USER_PARAMS)).toBe(false);
    expect(hasActiveUserFilters({ ...DEFAULT_USER_PARAMS, page: 3 })).toBe(false);
    expect(hasActiveUserFilters({ ...DEFAULT_USER_PARAMS, status: "active" })).toBe(true);
    expect(hasActiveUserFilters({ ...DEFAULT_USER_PARAMS, q: "x" })).toBe(true);
  });
});
