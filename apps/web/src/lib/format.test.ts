import { describe, expect, it } from "vitest";
import { formatDate } from "./format";

describe("formatDate", () => {
  it("formats as dd.MM.yyyy", () => {
    expect(formatDate("2025-01-10T09:00:00.000Z")).toBe("10.01.2025");
  });

  it("uses the Europe/Istanbul time zone (UTC+3)", () => {
    // 22:30 UTC is already the next day in Istanbul
    expect(formatDate("2025-03-31T22:30:00.000Z")).toBe("01.04.2025");
  });

  it("returns a dash for empty values", () => {
    expect(formatDate(null)).toBe("-");
  });
});
