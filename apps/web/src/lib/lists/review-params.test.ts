import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_DUE_PARAMS, hasActiveReviewDueFilters, parseReviewDueParams, toReviewDueQuery, toReviewDueSearchString } from "./review-params";

const UUID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";
const parse = (query: string) => parseReviewDueParams(new URLSearchParams(query));

describe("review due list params", () => {
  it("has no filter by default", () => {
    expect(parse("")).toEqual(DEFAULT_REVIEW_DUE_PARAMS);
  });

  it("reads valid values and ignores the rest", () => {
    expect(parse(`q=%20Prosedür%20&department=${UUID}&page=3`)).toEqual({ q: "Prosedür", department: UUID, page: 3 });
    expect(parse("department=x&page=0")).toEqual(DEFAULT_REVIEW_DUE_PARAMS);
    expect(parse("page=1.5").page).toBe(1);
  });

  it("writes only what differs from the defaults, and round-trips", () => {
    expect(toReviewDueSearchString(DEFAULT_REVIEW_DUE_PARAMS)).toBe("");
    const params = { q: "a", department: UUID, page: 2 };
    expect(parse(toReviewDueSearchString(params).slice(1))).toEqual(params);
  });

  it("builds the query without empty filters, and knows when a filter is on", () => {
    expect(toReviewDueQuery(DEFAULT_REVIEW_DUE_PARAMS)).toEqual({ page: 1, pageSize: 20 });
    expect(toReviewDueQuery({ q: "a", department: UUID, page: 2 })).toMatchObject({ search: "a", departmentId: UUID, page: 2 });
    expect(hasActiveReviewDueFilters(DEFAULT_REVIEW_DUE_PARAMS)).toBe(false);
    expect(hasActiveReviewDueFilters({ ...DEFAULT_REVIEW_DUE_PARAMS, page: 4 })).toBe(false);
    expect(hasActiveReviewDueFilters({ ...DEFAULT_REVIEW_DUE_PARAMS, q: "x" })).toBe(true);
  });
});
