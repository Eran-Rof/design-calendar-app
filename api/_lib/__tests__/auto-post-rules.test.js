// Tests for the P6-7 auto-post fee rules engine + bank-accounts/[id] PATCH validator.

import { describe, it, expect } from "vitest";
import {
  validateRule,
  validateRulesArray,
  findMatchingRule,
} from "../bank-feeds/autoPostRules.js";
import { validatePatch } from "../../_handlers/internal/bank-accounts/[id].js";

const UUID  = "550e8400-e29b-41d4-a716-446655440000";
const UUID2 = "11111111-1111-1111-1111-111111111111";

describe("validateRule", () => {
  it("rejects non-object", () => {
    expect(validateRule(null).error).toMatch(/object/);
    expect(validateRule("x").error).toMatch(/object/);
    expect(validateRule([]).error).toMatch(/object/);
  });
  it("rejects missing match", () => {
    expect(validateRule({ target_account_id: UUID }).error).toMatch(/match/);
  });
  it("rejects bad regex", () => {
    expect(validateRule({ match: "(", target_account_id: UUID }).error).toMatch(/regex/);
  });
  it("rejects missing/bad target_account_id", () => {
    expect(validateRule({ match: "FEE" }).error).toMatch(/target_account_id/);
    expect(validateRule({ match: "FEE", target_account_id: "abc" }).error).toMatch(/target_account_id/);
  });
  it("rejects bad max_amount_cents", () => {
    expect(validateRule({ match: "FEE", target_account_id: UUID, max_amount_cents: -1 }).error).toMatch(/max_amount_cents/);
    expect(validateRule({ match: "FEE", target_account_id: UUID, max_amount_cents: 1.5 }).error).toMatch(/max_amount_cents/);
    expect(validateRule({ match: "FEE", target_account_id: UUID, max_amount_cents: "abc" }).error).toMatch(/max_amount_cents/);
  });
  it("rejects bad direction", () => {
    expect(validateRule({ match: "FEE", target_account_id: UUID, direction: "weird" }).error).toMatch(/direction/);
  });
  it("rejects label > 80 chars", () => {
    expect(validateRule({ match: "FEE", target_account_id: UUID, label: "x".repeat(81) }).error).toMatch(/label/);
  });
  it("normalizes a valid minimal rule", () => {
    const v = validateRule({ match: "FEE", target_account_id: UUID });
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({
      match: "FEE",
      target_account_id: UUID,
      max_amount_cents: null,
      direction: "both",
      label: null,
    });
  });
  it("normalizes a full rule", () => {
    const v = validateRule({
      match: "^MONTHLY",
      target_account_id: UUID,
      max_amount_cents: 5000,
      direction: "withdrawal",
      label: "  Monthly bank fee  ",
    });
    expect(v.data).toEqual({
      match: "^MONTHLY",
      target_account_id: UUID,
      max_amount_cents: 5000,
      direction: "withdrawal",
      label: "Monthly bank fee",
    });
  });
});

describe("validateRulesArray", () => {
  it("rejects non-array", () => {
    expect(validateRulesArray({}).error).toMatch(/array/);
  });
  it("accepts empty", () => {
    expect(validateRulesArray([]).data).toEqual([]);
  });
  it("rejects > 50 entries", () => {
    const r = Array.from({ length: 51 }, () => ({ match: "FEE", target_account_id: UUID }));
    expect(validateRulesArray(r).error).toMatch(/50/);
  });
  it("surfaces per-entry error with index", () => {
    expect(validateRulesArray([
      { match: "FEE", target_account_id: UUID },
      { match: "(",   target_account_id: UUID },
    ]).error).toMatch(/rule\[1\]/);
  });
});

describe("findMatchingRule", () => {
  const target = UUID2;
  const baseRule = { match: "FEE", target_account_id: target, max_amount_cents: null, direction: "both", label: null };

  it("returns null on empty rules", () => {
    expect(findMatchingRule([], { description: "FEE", amount_cents: -500 })).toBeNull();
  });
  it("returns null when no fields to match", () => {
    expect(findMatchingRule([baseRule], { description: null, merchant_name: null, amount_cents: -500 })).toBeNull();
  });
  it("returns null on zero amount", () => {
    expect(findMatchingRule([baseRule], { description: "FEE", amount_cents: 0 })).toBeNull();
  });
  it("matches case-insensitively", () => {
    expect(findMatchingRule([baseRule], { description: "monthly fee", amount_cents: -500 })).not.toBeNull();
  });
  it("matches against merchant_name too", () => {
    expect(findMatchingRule([baseRule], { description: null, merchant_name: "Bank Fee Charge", amount_cents: -500 })).not.toBeNull();
  });
  it("respects max_amount_cents (abs value)", () => {
    const r = [{ ...baseRule, max_amount_cents: 1000 }];
    expect(findMatchingRule(r, { description: "FEE", amount_cents: -500 })).not.toBeNull();
    expect(findMatchingRule(r, { description: "FEE", amount_cents: -1500 })).toBeNull();
  });
  it("respects direction=deposit", () => {
    const r = [{ ...baseRule, direction: "deposit" }];
    expect(findMatchingRule(r, { description: "INTEREST", amount_cents: 50 })).toBeNull(); // doesn't match pattern
    expect(findMatchingRule(r, { description: "FEE", amount_cents: 50 })).not.toBeNull();
    expect(findMatchingRule(r, { description: "FEE", amount_cents: -50 })).toBeNull();
  });
  it("respects direction=withdrawal", () => {
    const r = [{ ...baseRule, direction: "withdrawal" }];
    expect(findMatchingRule(r, { description: "FEE", amount_cents: -50 })).not.toBeNull();
    expect(findMatchingRule(r, { description: "FEE", amount_cents: 50 })).toBeNull();
  });
  it("first-match-wins ordering", () => {
    const a = { ...baseRule, label: "first" };
    const b = { ...baseRule, label: "second" };
    const m = findMatchingRule([a, b], { description: "FEE", amount_cents: -50 });
    expect(m.index).toBe(0);
    expect(m.rule.label).toBe("first");
  });
  it("skips entries with invalid regex (defensive)", () => {
    const bad  = { match: "(", target_account_id: target };
    const good = { match: "FEE", target_account_id: target };
    expect(findMatchingRule([bad, good], { description: "FEE", amount_cents: -50 })?.index).toBe(1);
  });
});

describe("bank-accounts [id] validatePatch", () => {
  it("rejects non-object body", () => {
    expect(validatePatch(null).error).toMatch(/object/);
    expect(validatePatch([]).error).toMatch(/object/);
  });
  it("rejects empty body", () => {
    expect(validatePatch({}).error).toMatch(/No fields/);
  });
  it("validates is_active boolean", () => {
    expect(validatePatch({ is_active: "true" }).error).toMatch(/is_active/);
    expect(validatePatch({ is_active: false }).data.is_active).toBe(false);
  });
  it("validates name length", () => {
    expect(validatePatch({ name: "" }).error).toMatch(/empty/);
    expect(validatePatch({ name: "x".repeat(81) }).error).toMatch(/80/);
    expect(validatePatch({ name: "  Chase 1234  " }).data.name).toBe("Chase 1234");
  });
  it("accepts auto_post_fee_rules and normalizes", () => {
    const v = validatePatch({
      auto_post_fee_rules: [
        { match: "FEE", target_account_id: UUID, label: "Bank fee" },
      ],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.auto_post_fee_rules).toHaveLength(1);
    expect(v.data.auto_post_fee_rules[0]).toEqual({
      match: "FEE", target_account_id: UUID, max_amount_cents: null, direction: "both", label: "Bank fee",
    });
  });
  it("rejects bad auto_post_fee_rules", () => {
    expect(validatePatch({ auto_post_fee_rules: "x" }).error).toMatch(/array/);
    expect(validatePatch({ auto_post_fee_rules: [{ match: "x" }] }).error).toMatch(/target_account_id/);
  });
  it("accepts csv_column_mapping null or object", () => {
    expect(validatePatch({ csv_column_mapping: null }).data.csv_column_mapping).toBeNull();
    expect(validatePatch({ csv_column_mapping: { date: "Date" } }).data.csv_column_mapping).toEqual({ date: "Date" });
    expect(validatePatch({ csv_column_mapping: [] }).error).toMatch(/object/);
  });
});
