// Tests for Tangerine P7-6 — Sales Reps + tiers + assignments handlers.
//
// Pure validators only. Live insert/upsert behaviour is covered by the
// schema's own migration tests (P7-4) + the deployed app smoke test.

import { describe, it, expect } from "vitest";

import {
  parseListQuery,
  validateInsert,
  isUuid,
} from "../../_handlers/internal/sales-reps/index.js";
import { validatePatch } from "../../_handlers/internal/sales-reps/[id].js";
import {
  validateTierInsert,
  isISODate as tiersIsISODate,
} from "../../_handlers/internal/sales-reps/[id]/tiers.js";
import {
  validateAssignmentInsert,
  isISODate as assignIsISODate,
} from "../../_handlers/internal/sales-reps/[id]/assignments.js";

const UUID  = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";

// ────────────────────────────────────────────────────────────────────────
// index.js — isUuid + parseListQuery + validateInsert
// ────────────────────────────────────────────────────────────────────────

describe("sales-reps isUuid", () => {
  it("accepts a canonical uuid", () => {
    expect(isUuid(UUID)).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isUuid("abc")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});

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

describe("sales-reps validateInsert", () => {
  it("requires display_name", () => {
    expect(validateInsert({}).error).toMatch(/display_name/);
    expect(validateInsert({ display_name: "   " }).error).toMatch(/display_name/);
  });
  it("rejects display_name over 200 chars", () => {
    expect(validateInsert({ display_name: "x".repeat(201) }).error).toMatch(/200/);
  });
  it("accepts the minimum valid body", () => {
    const v = validateInsert({ display_name: "Jane Smith" });
    expect(v.error).toBeUndefined();
    expect(v.data.display_name).toBe("Jane Smith");
    expect(v.data.email).toBeNull();
    expect(v.data.default_commission_pct).toBe(0);
    expect(v.data.payout_terms_days).toBe(30);
    expect(v.data.is_active).toBe(true);
    expect(v.data.employee_id).toBeNull();
  });
  it("rejects email > 320 chars", () => {
    const v = validateInsert({ display_name: "x", email: "a".repeat(321) });
    expect(v.error).toMatch(/email/);
  });
  it("rejects default_commission_pct outside 0..100", () => {
    expect(validateInsert({ display_name: "x", default_commission_pct: -1 }).error).toMatch(/0 and 100/);
    expect(validateInsert({ display_name: "x", default_commission_pct: 100.01 }).error).toMatch(/0 and 100/);
  });
  it("accepts default_commission_pct at boundaries", () => {
    expect(validateInsert({ display_name: "x", default_commission_pct: 0 }).data.default_commission_pct).toBe(0);
    expect(validateInsert({ display_name: "x", default_commission_pct: 100 }).data.default_commission_pct).toBe(100);
  });
  it("rejects non-numeric default_commission_pct", () => {
    expect(validateInsert({ display_name: "x", default_commission_pct: "abc" }).error).toMatch(/number/);
  });
  it("rejects negative payout_terms_days", () => {
    expect(validateInsert({ display_name: "x", payout_terms_days: -1 }).error).toMatch(/non-negative/);
  });
  it("rejects non-integer payout_terms_days", () => {
    expect(validateInsert({ display_name: "x", payout_terms_days: 2.5 }).error).toMatch(/non-negative integer/);
  });
  it("accepts payout_terms_days = 0", () => {
    expect(validateInsert({ display_name: "x", payout_terms_days: 0 }).data.payout_terms_days).toBe(0);
  });
  it("rejects bad employee_id", () => {
    expect(validateInsert({ display_name: "x", employee_id: "nope" }).error).toMatch(/employee_id/);
  });
  it("accepts a valid employee_id", () => {
    expect(validateInsert({ display_name: "x", employee_id: UUID }).data.employee_id).toBe(UUID);
  });
  it("rejects bad created_by_user_id", () => {
    expect(validateInsert({ display_name: "x", created_by_user_id: "nope" }).error).toMatch(/created_by_user_id/);
  });
  it("coerces is_active explicitly", () => {
    expect(validateInsert({ display_name: "x", is_active: false }).data.is_active).toBe(false);
    expect(validateInsert({ display_name: "x", is_active: 0 }).data.is_active).toBe(false);
    expect(validateInsert({ display_name: "x", is_active: true }).data.is_active).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// [id].js — validatePatch
// ────────────────────────────────────────────────────────────────────────

describe("sales-reps validatePatch", () => {
  it("rejects locked columns", () => {
    expect(validatePatch({ id: UUID }).error).toMatch(/id is not patchable/);
    expect(validatePatch({ entity_id: UUID }).error).toMatch(/entity_id/);
    expect(validatePatch({ created_at: "2026-01-01" }).error).toMatch(/created_at/);
    expect(validatePatch({ created_by_user_id: UUID }).error).toMatch(/created_by_user_id/);
  });
  it("returns empty patch for empty body", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({});
  });
  it("trims and stores display_name", () => {
    expect(validatePatch({ display_name: "  Bob  " }).data.display_name).toBe("Bob");
  });
  it("rejects empty display_name when supplied", () => {
    expect(validatePatch({ display_name: "" }).error).toMatch(/non-empty/);
    expect(validatePatch({ display_name: "   " }).error).toMatch(/non-empty/);
  });
  it("accepts null email", () => {
    expect(validatePatch({ email: null }).data.email).toBeNull();
    expect(validatePatch({ email: "" }).data.email).toBeNull();
  });
  it("rejects default_commission_pct outside 0..100", () => {
    expect(validatePatch({ default_commission_pct: 200 }).error).toMatch(/0 and 100/);
  });
  it("rejects non-integer payout_terms_days", () => {
    expect(validatePatch({ payout_terms_days: 2.5 }).error).toMatch(/non-negative/);
  });
  it("rejects bad employee_id", () => {
    expect(validatePatch({ employee_id: "garbage" }).error).toMatch(/employee_id/);
  });
  it("accepts null employee_id", () => {
    expect(validatePatch({ employee_id: null }).data.employee_id).toBeNull();
  });
  it("coerces is_active", () => {
    expect(validatePatch({ is_active: false }).data.is_active).toBe(false);
    expect(validatePatch({ is_active: 1 }).data.is_active).toBe(true);
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
    expect(isUuid(UUID2)).toBe(true);
  });
});
