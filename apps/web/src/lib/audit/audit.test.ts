import { AUDIT_ACTIONS } from "@iso-dms/shared";
import { describe, expect, it } from "vitest";
import { tr } from "@/lib/i18n/tr";
import { actionLabel, describeEntry } from "./describe";
import {
  hasActiveAuditFilters,
  parseAuditParams,
  toAuditQuery,
  toAuditSearchString,
  DEFAULT_AUDIT_PARAMS,
} from "./list-params";

const parse = (query: string) => parseAuditParams(new URLSearchParams(query));

describe("audit list params", () => {
  it("falls back to the defaults for an empty query", () => {
    expect(parse("")).toEqual(DEFAULT_AUDIT_PARAMS);
  });

  it("reads valid values", () => {
    expect(parse("q=PR-KK&action=REVISION_SAVED&from=2026-01-05&to=2026-02-01&page=3")).toEqual({
      q: "PR-KK",
      action: "REVISION_SAVED",
      from: "2026-01-05",
      to: "2026-02-01",
      page: 3,
    });
  });

  it.each([
    ["an unknown action", "action=EVERYTHING", "action"],
    ["a malformed day", "from=05.01.2026", "from"],
    ["a day that does not exist", "to=2026-02-31", "to"],
    ["a timestamp", "from=2026-01-05T10:00:00Z", "from"],
  ])("ignores %s", (_label, query, key) => {
    expect(parse(query)[key as "action" | "from" | "to"]).toBe("");
  });

  it.each(["0", "-2", "1.5", "abc"])("ignores the page %s", (page) => {
    expect(parse(`page=${page}`).page).toBe(1);
  });

  it("writes only values that differ from the defaults", () => {
    expect(toAuditSearchString(DEFAULT_AUDIT_PARAMS)).toBe("");
    expect(toAuditSearchString({ ...DEFAULT_AUDIT_PARAMS, action: "USER_LOGIN", page: 2 })).toBe("?action=USER_LOGIN&page=2");
  });

  it("round-trips through the query string", () => {
    const params = { q: "ece öz", action: "DOCUMENT_PUBLISHED" as const, from: "2026-01-01", to: "2026-01-31", page: 4 };
    expect(parse(toAuditSearchString(params))).toEqual(params);
  });

  it("builds the API query without empty filters", () => {
    expect(toAuditQuery({ ...DEFAULT_AUDIT_PARAMS, q: "x", page: 2 })).toEqual({
      search: "x",
      action: undefined,
      from: undefined,
      to: undefined,
      page: 2,
      pageSize: 20,
    });
  });

  it("knows whether a filter is active", () => {
    expect(hasActiveAuditFilters(DEFAULT_AUDIT_PARAMS)).toBe(false);
    expect(hasActiveAuditFilters({ ...DEFAULT_AUDIT_PARAMS, page: 5 })).toBe(false);
    expect(hasActiveAuditFilters({ ...DEFAULT_AUDIT_PARAMS, to: "2026-01-01" })).toBe(true);
  });
});

describe("audit labels", () => {
  it("has a Turkish label for every action the API can write", () => {
    expect(Object.keys(tr.audit.actions).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it("shows an action this build does not know as it is", () => {
    expect(actionLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(actionLabel("USER_LOGIN")).toBe(tr.audit.actions.USER_LOGIN);
  });
});

describe("describeEntry", () => {
  const d = tr.audit.details;
  const describe_ = (action: string, metadata: Record<string, unknown> | null) => describeEntry({ action, metadata });

  it("says in which mode a document was opened", () => {
    expect(describe_("DOCUMENT_OPENED", { mode: "edit" })).toBe(d.modeEdit);
    expect(describe_("DOCUMENT_OPENED", { mode: "view" })).toBe(d.modeView);
  });

  it("says where a new document came from", () => {
    expect(describe_("DOCUMENT_CREATED", { source: "TEMPLATE" })).toBe(d.sourceTemplate);
    expect(describe_("DOCUMENT_CREATED", { source: "UPLOAD" })).toBe(d.sourceUpload);
  });

  it("tells a manual save from the save at the end of a session, with the size", () => {
    expect(describe_("REVISION_SAVED", { forceSave: true, fileSize: 24576 })).toBe(`${d.savedManually} · 24 KB`);
    expect(describe_("REVISION_SAVED", { forceSave: false, fileSize: 2048 })).toBe(`${d.savedOnClose} · 2 KB`);
  });

  it("explains why a save was rejected, and shows an unknown reason as it is", () => {
    expect(describe_("REVISION_SAVE_REJECTED", { reason: "NOT_EDITABLE" })).toBe(d.reasons.NOT_EDITABLE);
    expect(describe_("REVISION_SAVE_REJECTED", { reason: "SOMETHING_NEW" })).toBe("SOMETHING_NEW");
  });

  it("shows the size of a download", () => {
    expect(describe_("REVISION_DOWNLOADED", { fileSize: 1024 })).toBe("1 KB");
  });

  it("tells the first publication from a later one", () => {
    expect(describe_("DOCUMENT_PUBLISHED", { firstPublication: true, previousRevisionNo: null })).toBe(d.firstPublication);
    expect(describe_("DOCUMENT_PUBLISHED", { firstPublication: false, previousRevisionNo: 1 })).toBe(d.supersedes(1));
  });

  it("explains a failed login", () => {
    expect(describe_("USER_LOGIN_FAILED", { reason: "UNKNOWN_USER", email: "x@example.com" })).toBe(`${d.reasons.UNKNOWN_USER} · x@example.com`);
    expect(describe_("USER_LOGIN_FAILED", { reason: "WRONG_PASSWORD" })).toBe(d.reasons.WRONG_PASSWORD);
  });

  it("explains a token reuse", () => {
    expect(describe_("REFRESH_TOKEN_REUSE_DETECTED", null)).toBe(d.sessionsClosed);
  });

  it.each(["USER_LOGIN", "USER_LOGOUT", "SOMETHING_NEW"])("has nothing to add for %s", (action) => {
    expect(describe_(action, null)).toBe("");
  });

  it("copes with missing or odd metadata", () => {
    expect(describe_("REVISION_SAVED", null)).toBe(d.savedOnClose);
    expect(describe_("DOCUMENT_PUBLISHED", { firstPublication: "yes", previousRevisionNo: "1" })).toBe("");
  });
});
