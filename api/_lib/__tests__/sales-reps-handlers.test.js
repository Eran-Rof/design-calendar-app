// Tests for Tangerine Sales Reps list (now sourced from sales-role employees)
// + commission tiers + assignments handlers.
//
// Pure validators only. The Sales Reps standalone MASTER (index.js POST +
// [id].js PATCH/DELETE) was retired when reps were unified into Employees, so
// validateInsert / validatePatch no longer exist. index.js now only exposes
// parseListQuery (the list filter parser).

import { describe, it, expect } from "vitest";

import {
  parseListQuery,
} from "../../_handlers/internal/sales-reps/index.js";
import {
  validateTierInsert,
  isISODate as tiersIsISODate,
} from "../../_handlers/internal/sales-reps/[id]/tiers.js";
import {
  validateAssignmentInsert,
  isISODate as assignIsISODate,
} from "../../_handlers/internal/sales-reps/[id]/assignments.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID  = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";

// ────────────────────────────────────────────────────────────────────────
// index.js — parseListQuery (list filters)
// ────────────────────────────────────────────────────────────────────────

describe("sales-reps parseListQuery", () => {
  it("defaults to active-only with limit 200", () => {
    const v = parseListQuery({});
    expect(v.error).toBeUndefined();
    expect(v.data.q).toBeNull();
    expect(v.data.include_inactive).toBe(false);
    expect(v.data.limit).toBe(200);
  });
  it("accepts include_inactive=1", () => {
    expect(parseListQuery({ include_inactive: "1" }).data.include_inactive).toBe(true);
  });
  it("accepts include_inactive=true", () => {
    expect(parseListQuery({ include_inactive: "true" }).data.include_inactive).toBe(true);
  });
  it("ignores random include_inactive values", () => {
    expect(parseListQuery({ include_inactive: "yes" }).data.include_inactive).toBe(false);
  });
  it("clamps limit to 500", () => {
    expect(parseListQuery({ limit: "9999" }).data.limit).toBe(500);
  });
  it("falls back to default limit when garbage", () => {
    expect(parseListQuery({ limit: "abc" }).data.limit).toBe(200);
  });
  it("rejects q longer than 200 chars", () => {
    expect(parseListQuery({ q: "x".repeat(201) }).error).toMatch(/q/);
  });
  it("trims and stores q", () => {
    expect(parseListQuery({ q: "  smith  " }).data.q).toBe("smith");
  });
});

// ────────────────────────────────────────────────────────────────────────
// tiers.js — validateTierInsert + isISODate
// ────────────────────────────────────────────────────────────────────────

describe("tiers isISODate", () => {
  it("accepts a valid ISO date", () => {
    expect(tiersIsISODate("2026-05-28")).toBe(true);
  });
  it("rejects bad shapes", () => {
    expect(tiersIsISODate("28/05/2026")).toBe(false);
    expect(tiersIsISODate("2026-5-28")).toBe(false);
    expect(tiersIsISODate("not a date")).toBe(false);
    expect(tiersIsISODate(null)).toBe(false);
  });
  it("rejects invalid calendar days", () => {
    expect(tiersIsISODate("2026-02-30")).toBe(false);
  });
});

describe("validateTierInsert", () => {
  it("requires threshold_cents", () => {
    expect(validateTierInsert({ rate_pct: 5 }).error).toMatch(/threshold_cents/);
  });
  it("rejects negative threshold_cents", () => {
    expect(validateTierInsert({ threshold_cents: -1, rate_pct: 5 }).error).toMatch(/non-negative/);
  });
  it("rejects non-integer threshold_cents", () => {
    expect(validateTierInsert({ threshold_cents: 99.5, rate_pct: 5 }).error).toMatch(/non-negative/);
  });
  it("requires rate_pct", () => {
    expect(validateTierInsert({ threshold_cents: 0 }).error).toMatch(/rate_pct/);
  });
  it("rejects rate_pct outside 0..100", () => {
    expect(validateTierInsert({ threshold_cents: 0, rate_pct: -1 }).error).toMatch(/between 0 and 100/);
    expect(validateTierInsert({ threshold_cents: 0, rate_pct: 100.01 }).error).toMatch(/between 0 and 100/);
  });
  it("accepts the minimum valid body and defaults effective_from to today", () => {
    const v = validateTierInsert({ threshold_cents: 0, rate_pct: 5 });
    expect(v.error).toBeUndefined();
    expect(v.data.threshold_cents).toBe(0);
    expect(v.data.rate_pct).toBe(5);
    expect(v.data.effective_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v.data.effective_to).toBeNull();
  });
  it("rejects bad effective_from", () => {
    expect(validateTierInsert({ threshold_cents: 0, rate_pct: 5, effective_from: "bogus" }).error).toMatch(/effective_from/);
  });
  it("rejects effective_to before effective_from", () => {
    expect(validateTierInsert({
      threshold_cents: 0, rate_pct: 5,
      effective_from: "2026-05-01", effective_to: "2026-04-30",
    }).error).toMatch(/on or after/);
  });
  it("accepts equal effective_from + effective_to", () => {
    const v = validateTierInsert({
      threshold_cents: 0, rate_pct: 5,
      effective_from: "2026-05-01", effective_to: "2026-05-01",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.effective_to).toBe("2026-05-01");
  });
});

// ────────────────────────────────────────────────────────────────────────
// assignments.js — validateAssignmentInsert + isISODate
// ────────────────────────────────────────────────────────────────────────

describe("assignments isISODate", () => {
  it("accepts a valid ISO date", () => {
    expect(assignIsISODate("2026-05-28")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(assignIsISODate("nope")).toBe(false);
  });
});

describe("validateAssignmentInsert", () => {
  it("requires customer_id", () => {
    expect(validateAssignmentInsert({}).error).toMatch(/customer_id/);
  });
  it("rejects non-uuid customer_id", () => {
    expect(validateAssignmentInsert({ customer_id: "abc" }).error).toMatch(/customer_id/);
  });
  it("accepts a valid customer_id with all defaults", () => {
    const v = validateAssignmentInsert({ customer_id: UUID });
    expect(v.error).toBeUndefined();
    expect(v.data.customer_id).toBe(UUID);
    expect(v.data.share_pct).toBe(100);
    expect(v.data.effective_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v.data.effective_to).toBeNull();
  });
  it("rejects share_pct <= 0", () => {
    expect(validateAssignmentInsert({ customer_id: UUID, share_pct: 0 }).error).toMatch(/share_pct/);
    expect(validateAssignmentInsert({ customer_id: UUID, share_pct: -10 }).error).toMatch(/share_pct/);
  });
  it("rejects share_pct > 100", () => {
    expect(validateAssignmentInsert({ customer_id: UUID, share_pct: 100.01 }).error).toMatch(/share_pct/);
  });
  it("accepts share_pct = 100", () => {
    const v = validateAssignmentInsert({ customer_id: UUID, share_pct: 100 });
    expect(v.error).toBeUndefined();
    expect(v.data.share_pct).toBe(100);
  });
  it("rejects bad effective_from", () => {
    expect(validateAssignmentInsert({ customer_id: UUID, effective_from: "bogus" }).error).toMatch(/effective_from/);
  });
  it("rejects effective_to before effective_from", () => {
    expect(validateAssignmentInsert({
      customer_id: UUID,
      effective_from: "2026-05-01",
      effective_to: "2026-04-30",
    }).error).toMatch(/on or after/);
  });
  it("rejects body=null", () => {
    expect(validateAssignmentInsert(null).error).toMatch(/Body/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Smoke: ensure UUID2 isn't accidentally collapsed
// ────────────────────────────────────────────────────────────────────────

describe("sales-reps UUID smoke", () => {
  it("two different valid UUIDs are distinct", () => {
    expect(UUID).not.toBe(UUID2);
    expect(UUID_RE.test(UUID2)).toBe(true);
  });
});
