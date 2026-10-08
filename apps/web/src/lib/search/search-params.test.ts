import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_PARAMS,
  hasActiveSearchFilters,
  isSearchable,
  parseSearchParams,
  toSearchQuery,
  toSearchString,
} from "./search-params";

const ID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";
const parse = (query: string) => parseSearchParams(new URLSearchParams(query));

describe("parseSearchParams", () => {
  it("reads valid values", () => {
    expect(parse(`q=saklama%20s%C3%BCresi&department=${ID}&category=${ID}&page=3`)).toEqual({ q: "saklama süresi", department: ID, category: ID, page: 3 });
  });

  it("falls back to the defaults for missing or invalid values", () => {
    expect(parse("")).toEqual(DEFAULT_SEARCH_PARAMS);
    expect(parse("department=x&category=y&page=0")).toEqual(DEFAULT_SEARCH_PARAMS);
    expect(parse("page=1.5").page).toBe(1);
  });

  it("trims the words and cuts them at the longest the API takes", () => {
    expect(parse("q=%20%20abc%20%20").q).toBe("abc");
    expect(parse(`q=${"a".repeat(150)}`).q).toHaveLength(100);
  });
});

describe("toSearchString", () => {
  it("writes only what differs from the defaults", () => {
    expect(toSearchString(DEFAULT_SEARCH_PARAMS)).toBe("");
    expect(toSearchString({ q: "saklama", department: "", category: "", page: 1 })).toBe("?q=saklama");
    expect(toSearchString({ q: "a b", department: ID, category: ID, page: 2 })).toBe(`?q=a+b&department=${ID}&category=${ID}&page=2`);
  });

  it("round-trips through parse", () => {
    const params = { q: '"saklama süresi" PR-KK', department: ID, category: "", page: 4 };
    expect(parse(toSearchString(params))).toEqual(params);
  });
});

describe("toSearchQuery, isSearchable and filters", () => {
  it("maps to the API query", () => {
    expect(toSearchQuery({ q: "x y", department: ID, category: "", page: 2 })).toEqual({ q: "x y", departmentId: ID, categoryId: undefined, page: 2, pageSize: 20 });
  });

  it("asks the server only for two characters or more", () => {
    expect(isSearchable("")).toBe(false);
    expect(isSearchable(" a ")).toBe(false);
    expect(isSearchable("ab")).toBe(true);
  });

  it("tells whether a filter is set (the words are not a filter)", () => {
    expect(hasActiveSearchFilters({ ...DEFAULT_SEARCH_PARAMS, q: "x" })).toBe(false);
    expect(hasActiveSearchFilters({ ...DEFAULT_SEARCH_PARAMS, category: ID })).toBe(true);
  });
});
