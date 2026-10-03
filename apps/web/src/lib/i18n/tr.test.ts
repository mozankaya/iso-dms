import { describe, expect, it } from "vitest";
import { errorMessage, tr } from "./tr";

describe("errorMessage", () => {
  it("translates known API error codes", () => {
    expect(errorMessage({ code: "INVALID_CREDENTIALS", status: 401 })).toBe(tr.errors.INVALID_CREDENTIALS);
    expect(errorMessage({ code: "FORBIDDEN", status: 403 })).toBe(tr.errors.FORBIDDEN);
  });

  it("falls back to the HTTP status when the code is unknown", () => {
    expect(errorMessage({ code: "SOMETHING_NEW", status: 429 })).toBe(tr.errors.TOO_MANY_REQUESTS);
    expect(errorMessage({ status: 403 })).toBe(tr.errors.FORBIDDEN);
  });

  it("uses a generic message otherwise", () => {
    expect(errorMessage({ status: 500 })).toBe(tr.errors.UNKNOWN);
  });
});
