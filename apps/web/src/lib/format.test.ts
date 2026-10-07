import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatFileSize } from "./format";

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

describe("formatDateTime", () => {
  it("formats as dd.MM.yyyy HH:mm in Istanbul time", () => {
    expect(formatDateTime("2025-01-10T09:05:00.000Z")).toBe("10.01.2025 12:05");
  });

  it("rolls over to the next day like formatDate does", () => {
    expect(formatDateTime("2025-03-31T22:30:00.000Z")).toBe("01.04.2025 01:30");
  });

  it("writes midnight as 00:00, not 24:00", () => {
    expect(formatDateTime("2025-03-31T21:00:00.000Z")).toBe("01.04.2025 00:00");
  });

  it("returns a dash for empty values", () => {
    expect(formatDateTime(null)).toBe("-");
  });
});

describe("formatFileSize", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [24576, "24 KB"],
    [1024 * 1024, "1 MB"],
    [1.5 * 1024 * 1024, "1,5 MB"],
  ])("formats %i bytes as %s", (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });

  it.each([null, -1, Number.NaN])("returns a dash for %s", (bytes) => {
    expect(formatFileSize(bytes)).toBe("-");
  });
});
