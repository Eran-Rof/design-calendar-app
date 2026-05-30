// Tests for Tangerine P13-5 — M26 QC inspection + findings handler
// validators. Live posting is exercised by the migration shape tests +
// the UI integration tests; this file covers pure-function validation
// logic exported from each handler module.

import { describe, it, expect } from "vitest";

import {
  parseListQuery as parseInspectionListQuery,
  validateInspectionInsert,
  isUuid as inspIsUuid,
} from "../../_handlers/internal/procurement/qc-inspections/index.js";
import {
  validateInspectionPatch,
  INSPECTION_TRANSITIONS,
} from "../../_handlers/internal/procurement/qc-inspections/[id].js";
import {
  parseListQuery as parseFindingListQuery,
  validateFindingInsert,
  isUuid as findIsUuid,
} from "../../_handlers/internal/procurement/qc-findings/index.js";
import {
  validateFindingPatch,
  validateFindingDelete,
} from "../../_handlers/internal/procurement/qc-findings/[id].js";

const UUID  = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";
const UUID3 = "00000000-0000-0000-0000-000000000003";

// ────────────────────────────────────────────────────────────────────────
// uuid sanity (h503 + h506)
// ────────────────────────────────────────────────────────────────────────

describe("qc isUuid", () => {
  it("accepts a canonical uuid (inspections handler)", () => {
    expect(inspIsUuid(UUID)).toBe(true);
  });
  it("accepts a canonical uuid (findings handler)", () => {
    expect(findIsUuid(UUID)).toBe(true);
  });
  it("rejects garbage", () => {
    expect(inspIsUuid("abc")).toBe(false);
    expect(inspIsUuid(null)).toBe(false);
    expect(findIsUuid(undefined)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// h503 — parseInspectionListQuery
// ────────────────────────────────────────────────────────────────────────

describe("qc-inspections parseListQuery", () => {
  it("accepts empty params and defaults limit=200", () => {
    const v = parseInspectionListQuery({});
    expect(v.error).toBeUndefined();
    expect(v.data.limit).toBe(200);
    expect(v.data.include_passed).toBe(false);
  });

  it("clamps limit > 500 to 500", () => {
    expect(parseInspectionListQuery({ limit: "10000" }).data.limit).toBe(500);
  });

  it("rejects bogus status", () => {
    expect(parseInspectionListQuery({ status: "garbage" }).error).toMatch(/status/);
  });

  it("rejects non-uuid receipt_id", () => {
    expect(parseInspectionListQuery({ receipt_id: "x" }).error).toMatch(/receipt_id/);
  });

  it("rejects malformed from date", () => {
    expect(parseInspectionListQuery({ from: "5/29/2026" }).error).toMatch(/from/);
  });

  it("rejects malformed to date", () => {
    expect(parseInspectionListQuery({ to: "29-May" }).error).toMatch(/to/);
  });

  it("flips include_passed when query string is 'true'", () => {
    expect(parseInspectionListQuery({ include_passed: "true" }).data.include_passed).toBe(true);
  });

  it("passes-through a valid combo", () => {
    const v = parseInspectionListQuery({ status: "failed", receipt_id: UUID, from: "2026-05-01", to: "2026-05-29", limit: "50" });
    expect(v.error).toBeUndefined();
    expect(v.data.status).toBe("failed");
    expect(v.data.limit).toBe(50);
  });
});

// ────────────────────────────────────────────────────────────────────────
// h504 (paired with h503) — validateInspectionInsert
// ────────────────────────────────────────────────────────────────────────

describe("qc-inspections validateInspectionInsert", () => {
  it("rejects missing receipt_id", () => {
    expect(validateInspectionInsert({}).error).toMatch(/receipt_id/);
  });
  it("rejects non-uuid receipt_id", () => {
    expect(validateInspectionInsert({ receipt_id: "x" }).error).toMatch(/receipt_id/);
  });
  it("defaults inspection_date to today", () => {
    const v = validateInspectionInsert({ receipt_id: UUID });
    expect(v.error).toBeUndefined();
    expect(/^\d{4}-\d{2}-\d{2}$/.test(v.data.inspection_date)).toBe(true);
  });
  it("rejects malformed inspection_date", () => {
    expect(validateInspectionInsert({ receipt_id: UUID, inspection_date: "5/29/2026" }).error)
      .toMatch(/inspection_date/);
  });
  it("rejects non-uuid inspector_employee_id", () => {
    expect(validateInspectionInsert({ receipt_id: UUID, inspector_employee_id: "x" }).error)
      .toMatch(/inspector_employee_id/);
  });
  it("rejects unknown status", () => {
    expect(validateInspectionInsert({ receipt_id: UUID, status: "void" }).error).toMatch(/status/);
  });
  it("defaults status to pending", () => {
    expect(validateInspectionInsert({ receipt_id: UUID }).data.status).toBe("pending");
  });
  it("rejects overall_pass_rate > 1", () => {
    expect(validateInspectionInsert({ receipt_id: UUID, overall_pass_rate: 1.5 }).error)
      .toMatch(/overall_pass_rate/);
  });
  it("rejects overall_pass_rate < 0", () => {
    expect(validateInspectionInsert({ receipt_id: UUID, overall_pass_rate: -0.5 }).error)
      .toMatch(/overall_pass_rate/);
  });
  it("accepts a full valid inspection", () => {
    const v = validateInspectionInsert({
      receipt_id: UUID,
      inspection_date: "2026-05-29",
      inspector_employee_id: UUID2,
      status: "pending",
      overall_pass_rate: 0.95,
      notes: "container ABC",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.overall_pass_rate).toBe(0.95);
    expect(v.data.notes).toBe("container ABC");
  });
});

// ────────────────────────────────────────────────────────────────────────
// h505 — validateInspectionPatch + transition catalog
// ────────────────────────────────────────────────────────────────────────

describe("qc-inspections validateInspectionPatch", () => {
  it("rejects unknown status value", () => {
    expect(validateInspectionPatch({ status: "void" }, "pending").error).toMatch(/status/);
  });
  it("rejects illegal transition (passed → failed)", () => {
    expect(validateInspectionPatch({ status: "failed" }, "passed").error).toMatch(/Cannot transition/);
  });
  it("rejects illegal transition (failed → anywhere)", () => {
    expect(validateInspectionPatch({ status: "pending" }, "failed").error).toMatch(/Cannot transition/);
  });
  it("allows pending → failed", () => {
    const v = validateInspectionPatch({ status: "failed" }, "pending");
    expect(v.error).toBeUndefined();
    expect(v.data.status).toBe("failed");
  });
  it("allows pending → partial", () => {
    expect(validateInspectionPatch({ status: "partial" }, "pending").error).toBeUndefined();
  });
  it("allows partial → passed", () => {
    expect(validateInspectionPatch({ status: "passed" }, "partial").error).toBeUndefined();
  });
  it("allows partial → failed", () => {
    expect(validateInspectionPatch({ status: "failed" }, "partial").error).toBeUndefined();
  });
  it("treats no-op status (pending → pending) as a no-op (no error)", () => {
    const v = validateInspectionPatch({ status: "pending" }, "pending");
    expect(v.error).toBeUndefined();
    expect(v.data.status).toBe("pending");
  });
  it("rejects malformed inspection_date", () => {
    expect(validateInspectionPatch({ inspection_date: "5/29/2026" }, "pending").error)
      .toMatch(/inspection_date/);
  });
  it("rejects non-uuid inspector_employee_id", () => {
    expect(validateInspectionPatch({ inspector_employee_id: "x" }, "pending").error)
      .toMatch(/inspector_employee_id/);
  });
  it("rejects overall_pass_rate out of [0,1]", () => {
    expect(validateInspectionPatch({ overall_pass_rate: 2 }, "pending").error).toMatch(/overall_pass_rate/);
  });
  it("accepts overall_pass_rate=null", () => {
    const v = validateInspectionPatch({ overall_pass_rate: null }, "pending");
    expect(v.error).toBeUndefined();
    expect(v.data.overall_pass_rate).toBeNull();
  });
  it("trims notes", () => {
    expect(validateInspectionPatch({ notes: "  hello  " }, "pending").data.notes).toBe("hello");
  });
});

describe("qc-inspections INSPECTION_TRANSITIONS catalog", () => {
  it("pending → 3 targets (passed/failed/partial)", () => {
    expect(INSPECTION_TRANSITIONS.pending.size).toBe(3);
  });
  it("partial → 2 targets (passed/failed)", () => {
    expect(INSPECTION_TRANSITIONS.partial.has("passed")).toBe(true);
    expect(INSPECTION_TRANSITIONS.partial.has("failed")).toBe(true);
  });
  it("passed + failed are terminal", () => {
    expect(INSPECTION_TRANSITIONS.passed.size).toBe(0);
    expect(INSPECTION_TRANSITIONS.failed.size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// h506 — parseFindingListQuery
// ────────────────────────────────────────────────────────────────────────

describe("qc-findings parseListQuery", () => {
  it("rejects missing inspection_id", () => {
    expect(parseFindingListQuery({}).error).toMatch(/inspection_id/);
  });
  it("rejects non-uuid inspection_id", () => {
    expect(parseFindingListQuery({ inspection_id: "x" }).error).toMatch(/inspection_id/);
  });
  it("rejects bogus severity", () => {
    expect(parseFindingListQuery({ inspection_id: UUID, severity: "fatal" }).error).toMatch(/severity/);
  });
  it("accepts valid filter combo", () => {
    const v = parseFindingListQuery({ inspection_id: UUID, severity: "critical", limit: "50" });
    expect(v.error).toBeUndefined();
    expect(v.data.severity).toBe("critical");
    expect(v.data.limit).toBe(50);
  });
  it("clamps limit > 500", () => {
    expect(parseFindingListQuery({ inspection_id: UUID, limit: "9999" }).data.limit).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────────────────
// h507 (paired with h506) — validateFindingInsert
// ────────────────────────────────────────────────────────────────────────

describe("qc-findings validateFindingInsert", () => {
  it("rejects missing inspection_id", () => {
    expect(validateFindingInsert({}).error).toMatch(/inspection_id/);
  });
  it("rejects missing category", () => {
    expect(validateFindingInsert({ inspection_id: UUID }).error).toMatch(/category/);
  });
  it("rejects missing severity", () => {
    expect(validateFindingInsert({ inspection_id: UUID, category: "stitch" }).error).toMatch(/severity/);
  });
  it("rejects invalid severity", () => {
    expect(validateFindingInsert({ inspection_id: UUID, category: "stitch", severity: "fatal" }).error)
      .toMatch(/severity/);
  });
  it("rejects missing description", () => {
    expect(validateFindingInsert({ inspection_id: UUID, category: "stitch", severity: "minor" }).error)
      .toMatch(/description/);
  });
  it("rejects negative qty_affected", () => {
    expect(validateFindingInsert({
      inspection_id: UUID, category: "stitch", severity: "minor", description: "x", qty_affected: -1,
    }).error).toMatch(/qty_affected/);
  });
  it("defaults qty_affected to 0 when omitted", () => {
    const v = validateFindingInsert({
      inspection_id: UUID, category: "stitch", severity: "minor", description: "x",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.qty_affected).toBe(0);
  });
  it("rejects photo_urls not-an-array", () => {
    expect(validateFindingInsert({
      inspection_id: UUID, category: "x", severity: "minor", description: "y", photo_urls: "url",
    }).error).toMatch(/photo_urls/);
  });
  it("rejects photo_urls containing empty strings", () => {
    expect(validateFindingInsert({
      inspection_id: UUID, category: "x", severity: "minor", description: "y", photo_urls: ["a", "  "],
    }).error).toMatch(/photo_urls/);
  });
  it("accepts a full critical finding with photos", () => {
    const v = validateFindingInsert({
      inspection_id: UUID,
      category: "torn fabric",
      severity: "critical",
      qty_affected: 12,
      description: "Large tear across center seam",
      photo_urls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
      resolution: "Vendor RMA #1234",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.severity).toBe("critical");
    expect(v.data.photo_urls?.length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────
// h508 — validateFindingPatch + validateFindingDelete (T11 D3)
// ────────────────────────────────────────────────────────────────────────

describe("qc-findings validateFindingPatch", () => {
  it("rejects empty category on patch", () => {
    expect(validateFindingPatch({ category: "  " }).error).toMatch(/category/);
  });
  it("rejects unknown severity on patch", () => {
    expect(validateFindingPatch({ severity: "fatal" }).error).toMatch(/severity/);
  });
  it("rejects negative qty_affected on patch", () => {
    expect(validateFindingPatch({ qty_affected: -3 }).error).toMatch(/qty_affected/);
  });
  it("rejects empty description on patch", () => {
    expect(validateFindingPatch({ description: "   " }).error).toMatch(/description/);
  });
  it("accepts photo_urls=null (clear)", () => {
    const v = validateFindingPatch({ photo_urls: null });
    expect(v.error).toBeUndefined();
    expect(v.data.photo_urls).toBeNull();
  });
  it("rejects photo_urls bad entries", () => {
    expect(validateFindingPatch({ photo_urls: ["", "x"] }).error).toMatch(/photo_urls/);
  });
  it("nulls resolution when empty string", () => {
    const v = validateFindingPatch({ resolution: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.resolution).toBeNull();
  });
  it("accepts a full multi-field patch", () => {
    const v = validateFindingPatch({
      category: "stain",
      severity: "major",
      qty_affected: 5,
      description: "ink spot on collar",
      photo_urls: ["https://example.com/c.jpg"],
      resolution: "Vendor credit",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.severity).toBe("major");
  });
});

describe("qc-findings validateFindingDelete (T11 D3)", () => {
  it("rejects missing reason in body and query", () => {
    expect(validateFindingDelete({}).error).toMatch(/reason is required/);
  });
  it("rejects whitespace-only reason", () => {
    expect(validateFindingDelete({ reason: "   " }).error).toMatch(/reason is required/);
  });
  it("rejects reason > 500 chars", () => {
    expect(validateFindingDelete({ reason: "x".repeat(501) }).error).toMatch(/≤ 500/);
  });
  it("accepts body reason", () => {
    const v = validateFindingDelete({ reason: "miscategorized" });
    expect(v.error).toBeUndefined();
    expect(v.data.reason).toBe("miscategorized");
  });
  it("accepts query reason fallback (?reason= path)", () => {
    const v = validateFindingDelete({ reason_query: "duplicate row" });
    expect(v.error).toBeUndefined();
    expect(v.data.reason).toBe("duplicate row");
  });
  it("body reason wins over query reason when both supplied", () => {
    const v = validateFindingDelete({ reason: "body wins", reason_query: "query loses" });
    expect(v.error).toBeUndefined();
    expect(v.data.reason).toBe("body wins");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Cross-handler smoke — UUID set sanity
// ────────────────────────────────────────────────────────────────────────

describe("qc handlers — uuids agree", () => {
  it("inspIsUuid and findIsUuid both accept the canonical fixtures", () => {
    expect(inspIsUuid(UUID2)).toBe(true);
    expect(findIsUuid(UUID3)).toBe(true);
  });
});
