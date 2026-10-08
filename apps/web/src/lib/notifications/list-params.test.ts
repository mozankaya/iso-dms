import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PARAMS, parseNotificationParams, toNotificationSearchString } from "./list-params";

const parse = (query: string) => parseNotificationParams(new URLSearchParams(query));

describe("notification list params", () => {
  it("shows everything on the first page by default", () => {
    expect(parse("")).toEqual(DEFAULT_NOTIFICATION_PARAMS);
  });

  it("reads valid values and ignores the rest", () => {
    expect(parse("status=unread&page=3")).toEqual({ status: "unread", page: 3 });
    expect(parse("status=maybe&page=0")).toEqual(DEFAULT_NOTIFICATION_PARAMS);
    expect(parse("page=1.5").page).toBe(1);
  });

  it("writes only what differs from the defaults, and round-trips", () => {
    expect(toNotificationSearchString(DEFAULT_NOTIFICATION_PARAMS)).toBe("");
    expect(toNotificationSearchString({ status: "unread", page: 2 })).toBe("?status=unread&page=2");
    expect(parse("status=unread&page=2")).toEqual({ status: "unread", page: 2 });
  });
});
