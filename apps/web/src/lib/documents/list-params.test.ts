import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_PARAMS,
  hasActiveFilters,
  parseListParams,
  toDocumentQuery,
  toSearchString,
} from "./list-params";

const UUID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";

function parse(query: string) {
  return parseListParams(new URLSearchParams(query));
}

describe("parseListParams", () => {
  it("returns the defaults for an empty query string", () => {
    expect(parse("")).toEqual(DEFAULT_LIST_PARAMS);
  });

  it("reads every supported parameter", () => {
    expect(parse(`q=%20abc%20&department=${UUID}&status=DRAFT&sort=title&order=desc&page=3`)).toEqual({
      q: "abc",
      department: UUID,
      status: "DRAFT",
      sortBy: "title",
      sortOrder: "desc",
      page: 3,
    });
  });

  it.each([
    ["page=0", { page: 1 }],
    ["page=-2", { page: 1 }],
    ["page=abc", { page: 1 }],
    ["page=1.5", { page: 1 }],
    ["sort=passwordHash", { sortBy: "code" }],
    ["order=sideways", { sortOrder: "asc" }],
    ["status=DELETED", { status: "" }],
    ["department=not-a-uuid", { department: "" }],
  ])("falls back to the default for invalid input (%s)", (query, expected) => {
    expect(parse(query)).toMatchObject(expected);
  });
});

describe("toSearchString", () => {
  it("is empty when everything is at its default", () => {
    expect(toSearchString(DEFAULT_LIST_PARAMS)).toBe("");
  });

  it("only contains values that differ from the defaults", () => {
    expect(toSearchString({ ...DEFAULT_LIST_PARAMS, q: "form", page: 2 })).toBe("?q=form&page=2");
    expect(toSearchString({ ...DEFAULT_LIST_PARAMS, sortBy: "title", sortOrder: "desc" })).toBe(
      "?sort=title&order=desc",
    );
  });

  it("round-trips through parseListParams", () => {
    const params = {
      q: "iç tetkik",
      department: UUID,
      status: "PUBLISHED" as const,
      sortBy: "revisedAt" as const,
      sortOrder: "desc" as const,
      page: 4,
    };
    expect(parse(toSearchString(params).slice(1))).toEqual(params);
  });
});

describe("toDocumentQuery", () => {
  it("omits empty filters and adds the category and page size", () => {
    expect(toDocumentQuery(DEFAULT_LIST_PARAMS, "cat-1")).toEqual({
      categoryId: "cat-1",
      search: undefined,
      departmentId: undefined,
      status: undefined,
      sortBy: "code",
      sortOrder: "asc",
      page: 1,
      pageSize: 20,
    });
  });
});

describe("hasActiveFilters", () => {
  it("ignores sorting and paging", () => {
    expect(hasActiveFilters({ ...DEFAULT_LIST_PARAMS, page: 3, sortBy: "title" })).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_LIST_PARAMS, q: "x" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_LIST_PARAMS, status: "DRAFT" })).toBe(true);
  });
});
