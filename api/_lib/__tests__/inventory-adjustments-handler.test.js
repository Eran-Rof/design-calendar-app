// Tests for Tangerine P3-5 inventory-adjustments handlers — pure validation.

import { describe, it, expect } from "vitest";
import {
  validateInsert,
  parseListQuery,
  isUuid,
} from "../../_handlers/internal/inventory-adjustments/index.js";
import { validatePatch } from "../../_handlers/internal/inventory-adjustments/[id].js";

const UUID = "11111111-1111-1111-1111-111111111111";
const UUID2 = "22222222-2222-2222-2222-222222222222";

describe("isUuid", () => {
  it("accepts canonical uuid", () => expect(isUuid(UUID)).toBe(true));
  it("rejects bad shape", () => expect(isUuid("abc")).toBe(false));
  it("rejects non-string", () => expect(isUuid(123)).toBe(false));
});

describe("validateInsert", () => {
  it("rejects empty body", () => {
    expect(validateInsert({}).error).toMatch(/item_id/);
  });
  it("rejects bad item_id", () => {
    expect(validateInsert({ item_id: "bad" }).error).toMatch(/item_id/);
  });
  it("rejects invalid adjustment_type", () => {
    expect(validateInsert({
      item_id: UUID, adjustment_type: "bogus", qty_delta: 1, reason: "r", gl_account_id: UUID2,
    }).error).toMatch(/adjustment_type/);
  });
  it("rejects zero qty_delta", () => {
    expect(validateInsert({
      item_id: UUID, adjustment_type: "damage", qty_delta: 0, reason: "r", gl_account_id: UUID2,
    }).error).toMatch(/qty_delta/);
  });
  it("rejects non-numeric qty_delta", () => {
    expect(validateInsert({
      item_id: UUID, adjustment_type: "damage", qty_delta: "abc", reason: "r", gl_account_id: UUID2,
    }).error).toMatch(/qty_delta/);
  });
  it("rejects positive qty_delta without unit_cost_cents", () => {
    expect(validateInsert({
      item_id: UUID, adjustment_type: "found", qty_delta: 5, reason: "r", gl_account_id: UUID2,
    }).error).toMatch(/unit_cost_cents required/);
  });
  it("rejects negative qty_delta WITH unit_cost_cents", () => {
    expect(validateInsert({
      item_id: UUID, adjustment_type: "damage", qty_delta: -5, unit_cost_cents: 100, reason: "r", gl_account_id: UUID2,
    }).error).toMatch(/must be omitted/);
  });
  it("rejects negative unit_cost_cents on positive adj", () => {
    expect(validateInsert({
      item_id: UUID, adjustment_type: "found", qty_delta: 5, unit_cost_cents: -10, reason: "r", gl_account_id: UUID2,
    }).error).toMatch(/non-negative/);
  });
  it("rejects non-integer unit_cost_cents", () => {
    expect(validateInsert({
      item_id: UUID, adjustment_type: "found", qty_delta: 5, unit_cost_cents: 12.5, reason: "r", gl_account_id: UUID2,
    }).error).toMatch(/integer/);
  });
  it("rejects empty reason", () => {
    expect(validateInsert({
      item_id: UUID, adjustment_type: "damage", qty_delta: -5, reason: "   ", gl_account_id: UUID2,
    }).error).toMatch(/reason/);
  });
  it("rejects bad gl_account_id", () => {
    expect(validateInsert({
      item_id: UUID, adjustment_type: "damage", qty_delta: -5, reason: "r", gl_account_id: "bad",
    }).error).toMatch(/gl_account_id/);
  });
  it("accepts a valid negative draft", () => {
    const v = validateInsert({
      item_id: UUID, adjustment_type: "shrinkage", qty_delta: -5, reason: "missing units", gl_account_id: UUID2,
    });
    expect(v.error).toBeUndefined();
    expect(v.data.qty_delta).toBe(-5);
    expect(v.data.unit_cost_cents).toBeNull();
    expect(v.data.reason).toBe("missing units");
  });
  it("accepts a valid positive draft", () => {
    const v = validateInsert({
      item_id: UUID, adjustment_type: "found", qty_delta: 5, unit_cost_cents: 1250, reason: "found in stockroom", gl_account_id: UUID2,
    });
    expect(v.error).toBeUndefined();
    expect(v.data.qty_delta).toBe(5);
    expect(v.data.unit_cost_cents).toBe(1250);
  });
});

describe("parseListQuery", () => {
  const sp = (s) => new URLSearchParams(s);

  it("empty params → defaults", () => {
    const r = parseListQuery(sp(""));
    expect(r.error).toBeUndefined();
    expect(r.limit).toBe(100);
    expect(r.filters).toEqual({});
  });
  it("rejects bad item_id", () => {
    expect(parseListQuery(sp("item_id=bad")).error).toMatch(/item_id/);
  });
  it("accepts valid item_id filter", () => {
    const r = parseListQuery(sp(`item_id=${UUID}`));
    expect(r.filters.item_id).toBe(UUID);
  });
  it("rejects bad adjustment_type", () => {
    expect(parseListQuery(sp("adjustment_type=bogus")).error).toMatch(/adjustment_type/);
  });
  it("posted=true|false parsed", () => {
    expect(parseListQuery(sp("posted=true")).filters.posted).toBe(true);
    expect(parseListQuery(sp("posted=false")).filters.posted).toBe(false);
  });
  it("rejects bad posted", () => {
    expect(parseListQuery(sp("posted=maybe")).error).toMatch(/posted/);
  });
  it("rejects bad date", () => {
    expect(parseListQuery(sp("from=1/1/2026")).error).toMatch(/from/);
  });
  it("limit capped at 500", () => {
    expect(parseListQuery(sp("limit=9999")).limit).toBe(500);
  });
  it("rejects non-positive limit", () => {
    expect(parseListQuery(sp("limit=0")).error).toMatch(/limit/);
  });
});

describe("validatePatch", () => {
  const existing = {
    qty_delta: -5,
    unit_cost_cents: null,
    posted_je_id: null,
  };

  it("rejects empty body without error but empty data", () => {
    const v = validatePatch({}, existing);
    expect(v.error).toBeUndefined();
    expect(Object.keys(v.data)).toHaveLength(0);
  });
  it("rejects adjustment_type change", () => {
    expect(validatePatch({ adjustment_type: "damage" }, existing).error).toMatch(/adjustment_type/);
  });
  it("rejects item_id change", () => {
    expect(validatePatch({ item_id: UUID }, existing).error).toMatch(/item_id/);
  });
  it("rejects gl_account_id change", () => {
    expect(validatePatch({ gl_account_id: UUID }, existing).error).toMatch(/gl_account_id/);
  });
  it("rejects posted_je_id from PATCH", () => {
    expect(validatePatch({ posted_je_id: UUID }, existing).error).toMatch(/posted_je_id/);
  });
  it("accepts reason change", () => {
    expect(validatePatch({ reason: "updated" }, existing).data.reason).toBe("updated");
  });
  it("rejects empty reason", () => {
    expect(validatePatch({ reason: "   " }, existing).error).toMatch(/reason/);
  });
  it("rejects qty_delta=0", () => {
    expect(validatePatch({ qty_delta: 0 }, existing).error).toMatch(/qty_delta/);
  });
  it("rejects flipping negative to positive without cost", () => {
    // existing is negative; if we flip qty to positive, cost is still null → fail
    expect(validatePatch({ qty_delta: 5 }, existing).error).toMatch(/unit_cost_cents required/);
  });
  it("accepts flipping negative to positive with cost", () => {
    const v = validatePatch({ qty_delta: 5, unit_cost_cents: 100 }, existing);
    expect(v.error).toBeUndefined();
    expect(v.data.qty_delta).toBe(5);
    expect(v.data.unit_cost_cents).toBe(100);
  });
  it("accepts flipping positive to negative with cost null", () => {
    const pos = { qty_delta: 5, unit_cost_cents: 100, posted_je_id: null };
    const v = validatePatch({ qty_delta: -5, unit_cost_cents: null }, pos);
    expect(v.error).toBeUndefined();
    expect(v.data.qty_delta).toBe(-5);
    expect(v.data.unit_cost_cents).toBeNull();
  });
  it("rejects keeping positive but nulling cost", () => {
    const pos = { qty_delta: 5, unit_cost_cents: 100, posted_je_id: null };
    expect(validatePatch({ unit_cost_cents: null }, pos).error).toMatch(/required/);
  });
  it("rejects keeping negative but adding cost", () => {
    expect(validatePatch({ unit_cost_cents: 100 }, existing).error).toMatch(/must be null/);
  });
});
