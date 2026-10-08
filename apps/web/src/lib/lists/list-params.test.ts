import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUBLICATION_PARAMS,
  hasActivePublicationFilters,
  isPublicationListKind,
  parsePublicationParams,
  toPublicationQuery,
  toPublicationSearchString,
} from "./list-params";

const UUID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";
const parse = (query: string) => parsePublicationParams(new URLSearchParams(query));

describe("isPublicationListKind", () => {
  it.each(["new", "revised", "withdrawn"])("knows %s", (kind) => {
    expect(isPublicationListKind(kind)).toBe(true);
  });

  it.each(["", "deleted", "NEW", "../new"])("does not know %j", (kind) => {
    expect(isPublicationListKind(kind)).toBe(false);
  });
});

describe("parsePublicationParams", () => {
  it("returns the defaults for an empty query string", () => {
    expect(parse("")).toEqual(DEFAULT_PUBLICATION_PARAMS);
    expect(DEFAULT_PUBLICATION_PARAMS.period).toBe("30");
  });

  it("reads valid values", () => {
    expect(parse(`q=%20PR-KK%20&department=${UUID}&period=90&page=3`)).toEqual({ q: "PR-KK", department: UUID, period: "90", page: 3 });
  });

  it.each(["7", "30", "90", "all"])("accepts the period %s", (period) => {
    expect(parse(`period=${period}`).period).toBe(period);
  });

  it.each(["365", "0", "ALL", "week"])("falls back to 30 days for the period %s", (period) => {
    expect(parse(`period=${period}`).period).toBe("30");
  });

  it("ignores a department that is not a uuid", () => {
    expect(parse("department=abc").department).toBe("");
  });

  it.each(["0", "-1", "1.5", "abc"])("ignores the page %s", (page) => {
    expect(parse(`page=${page}`).page).toBe(1);
  });
});

describe("toPublicationSearchString", () => {
  it("writes nothing for the defaults", () => {
    expect(toPublicationSearchString(DEFAULT_PUBLICATION_PARAMS)).toBe("");
  });

  it("writes only values that differ from the defaults", () => {
    expect(toPublicationSearchString({ ...DEFAULT_PUBLICATION_PARAMS, period: "7", page: 2 })).toBe("?period=7&page=2");
    expect(toPublicationSearchString({ ...DEFAULT_PUBLICATION_PARAMS, period: "30" })).toBe("");
  });

  it("round-trips through the query string", () => {
    const params = { q: "ece öz", department: UUID, period: "all" as const, page: 4 };
    expect(parse(toPublicationSearchString(params))).toEqual(params);
  });
});

describe("toPublicationQuery", () => {
  it("always sends the period, and leaves empty filters out", () => {
    expect(toPublicationQuery(DEFAULT_PUBLICATION_PARAMS)).toEqual({ period: "30", departmentId: undefined, search: undefined, page: 1, pageSize: 20 });
    expect(toPublicationQuery({ q: "x", department: UUID, period: "7", page: 2 })).toEqual({ period: "7", departmentId: UUID, search: "x", page: 2, pageSize: 20 });
  });
});

describe("hasActivePublicationFilters", () => {
  it("counts a period other than the default as a filter, but not the page", () => {
    expect(hasActivePublicationFilters(DEFAULT_PUBLICATION_PARAMS)).toBe(false);
    expect(hasActivePublicationFilters({ ...DEFAULT_PUBLICATION_PARAMS, page: 5 })).toBe(false);
    expect(hasActivePublicationFilters({ ...DEFAULT_PUBLICATION_PARAMS, period: "all" })).toBe(true);
    expect(hasActivePublicationFilters({ ...DEFAULT_PUBLICATION_PARAMS, q: "x" })).toBe(true);
    expect(hasActivePublicationFilters({ ...DEFAULT_PUBLICATION_PARAMS, department: UUID })).toBe(true);
  });
});
