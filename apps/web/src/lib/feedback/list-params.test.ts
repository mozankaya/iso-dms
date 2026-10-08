import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEEDBACK_PARAMS,
  hasActiveFeedbackFilters,
  parseFeedbackParams,
  toFeedbackQuery,
  toFeedbackSearchString,
} from "./list-params";

const UUID = "3f2b8c1e-9a4d-4e6b-8c7f-1a2b3c4d5e6f";
const parse = (query: string) => parseFeedbackParams(new URLSearchParams(query));

describe("parseFeedbackParams", () => {
  it("shows the open feedback of all times by default", () => {
    expect(parse("")).toEqual(DEFAULT_FEEDBACK_PARAMS);
    expect(DEFAULT_FEEDBACK_PARAMS).toMatchObject({ status: "open", period: "all" });
  });

  it("reads valid values", () => {
    expect(parse(`q=%20Madde%20&department=${UUID}&status=resolved&period=7&page=3`)).toEqual({
      q: "Madde",
      department: UUID,
      status: "resolved",
      period: "7",
      page: 3,
    });
  });

  it.each(["open", "resolved", "all"])("accepts the status %s", (status) => {
    expect(parse(`status=${status}`).status).toBe(status);
  });

  it.each(["closed", "OPEN", "", "0"])("falls back to open for the status %j", (status) => {
    expect(parse(`status=${status}`).status).toBe("open");
  });

  it.each(["365", "week", "ALL"])("falls back to all times for the period %s", (period) => {
    expect(parse(`period=${period}`).period).toBe("all");
  });

  it("ignores a department that is not a uuid, and a page that is not a positive integer", () => {
    expect(parse("department=abc").department).toBe("");
    for (const page of ["0", "-1", "1.5", "abc"]) expect(parse(`page=${page}`).page).toBe(1);
  });
});

describe("toFeedbackSearchString", () => {
  it("writes nothing for the defaults, and only what differs otherwise", () => {
    expect(toFeedbackSearchString(DEFAULT_FEEDBACK_PARAMS)).toBe("");
    expect(toFeedbackSearchString({ ...DEFAULT_FEEDBACK_PARAMS, status: "all", page: 2 })).toBe("?status=all&page=2");
    expect(toFeedbackSearchString({ ...DEFAULT_FEEDBACK_PARAMS, status: "open", period: "all" })).toBe("");
  });

  it("round-trips through the query string", () => {
    const params = { q: "ece öz", department: UUID, status: "resolved" as const, period: "90" as const, page: 4 };
    expect(parse(toFeedbackSearchString(params))).toEqual(params);
  });
});

describe("toFeedbackQuery", () => {
  it("always sends status and period, and leaves empty filters out", () => {
    expect(toFeedbackQuery(DEFAULT_FEEDBACK_PARAMS)).toEqual({ status: "open", period: "all", departmentId: undefined, search: undefined, page: 1, pageSize: 20 });
    expect(toFeedbackQuery({ q: "x", department: UUID, status: "all", period: "7", page: 2 })).toEqual({
      status: "all",
      period: "7",
      departmentId: UUID,
      search: "x",
      page: 2,
      pageSize: 20,
    });
  });
});

describe("hasActiveFeedbackFilters", () => {
  it("counts everything but the page, measured against the defaults", () => {
    expect(hasActiveFeedbackFilters(DEFAULT_FEEDBACK_PARAMS)).toBe(false);
    expect(hasActiveFeedbackFilters({ ...DEFAULT_FEEDBACK_PARAMS, page: 5 })).toBe(false);
    expect(hasActiveFeedbackFilters({ ...DEFAULT_FEEDBACK_PARAMS, status: "all" })).toBe(true);
    expect(hasActiveFeedbackFilters({ ...DEFAULT_FEEDBACK_PARAMS, period: "30" })).toBe(true);
    expect(hasActiveFeedbackFilters({ ...DEFAULT_FEEDBACK_PARAMS, q: "x" })).toBe(true);
    expect(hasActiveFeedbackFilters({ ...DEFAULT_FEEDBACK_PARAMS, department: UUID })).toBe(true);
  });
});
