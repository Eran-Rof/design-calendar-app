// Tests for P3-6 finalize.js — pure helpers covering the variance fan-out:
//   - validateFinalizeBody: threshold / gl_account / positive_unit_costs parsing
//   - buildAdjustmentRow: maps a variance line to an inventory_adjustments row
//   - resolveUnitCostCents: override → avg cost → null fallback chain
//   - exceedsThreshold: |variance| / max(1, system) > pct/100

import { describe, it, expect } from "vitest";
import {
  validateFinalizeBody,
  buildAdjustmentRow,
  resolveUnitCostCents,
  exceedsThreshold,
} from "../../_handlers/internal/inventory-cycle-counts/finalize.js";

const ITEM     = "11111111-1111-1111-1111-111111111111";
const ITEM_B   = "22222222-2222-2222-2222-222222222222";
const LINE     = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LINE_B   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const GL_ACCT  = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ENTITY   = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const CC_ID    = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

describe("finalize validateFinalizeBody", () => {
  it("empty body -> defaults", () => {
    const v = validateFinalizeBody({});
    expect(v.error).toBeUndefined();
    expect(v.data.threshold_pct).toBe(10);
    expect(v.data.positive_unit_costs).toEqual({});
    expect(v.data.gl_account_id).toBeUndefined();
  });

  it("accepts threshold_pct in range", () => {
    expect(validateFinalizeBody({ threshold_pct: 5 }).data.threshold_pct).toBe(5);
    expect(validateFinalizeBody({ threshold_pct: 0 }).data.threshold_pct).toBe(0);
    expect(validateFinalizeBody({ threshold_pct: 100 }).data.threshold_pct).toBe(100);
  });

  it("rejects out-of-range threshold_pct", () => {
    expect(validateFinalizeBody({ threshold_pct: -1 }).error).toMatch(/threshold_pct/);
    expect(validateFinalizeBody({ threshold_pct: 150 }).error).toMatch(/threshold_pct/);
    expect(validateFinalizeBody({ threshold_pct: "abc" }).error).toMatch(/threshold_pct/);
  });

  it("accepts gl_account_id uuid", () => {
    const v = validateFinalizeBody({ gl_account_id: GL_ACCT });
    expect(v.error).toBeUndefined();
    expect(v.data.gl_account_id).toBe(GL_ACCT);
  });

  it("rejects bad gl_account_id", () => {
    expect(validateFinalizeBody({ gl_account_id: "not-a-uuid" }).error).toMatch(/gl_account_id/);
  });

  it("accepts positive_unit_costs map", () => {
    const v = validateFinalizeBody({ positive_unit_costs: { [LINE]: 1000 } });
    expect(v.error).toBeUndefined();
    expect(v.data.positive_unit_costs[LINE]).toBe(1000);
  });

  it("rejects positive_unit_costs as array", () => {
    expect(validateFinalizeBody({ positive_unit_costs: [1000] }).error).toMatch(/positive_unit_costs/);
  });

  it("rejects non-uuid key in positive_unit_costs", () => {
    expect(validateFinalizeBody({ positive_unit_costs: { foo: 100 } }).error).toMatch(/uuid/);
  });

  it("rejects negative cost in positive_unit_costs", () => {
    expect(validateFinalizeBody({ positive_unit_costs: { [LINE]: -1 } }).error).toMatch(/non-negative integer/);
  });

  it("rejects non-integer cost (cents must be integer)", () => {
    expect(validateFinalizeBody({ positive_unit_costs: { [LINE]: 10.5 } }).error).toMatch(/integer/);
  });
});

describe("finalize buildAdjustmentRow", () => {
  const ctx = {
    entity_id: ENTITY,
    gl_account_id: GL_ACCT,
    cycle_count_id: CC_ID,
    cycle_count_short: "deadbeef",
    unit_cost_cents_for_positive: 1500,
  };

  it("positive variance -> 'found' with unit_cost_cents", () => {
    const line = { id: LINE, item_id: ITEM, system_qty: 100, counted_qty: 110, variance_qty: 10 };
    const { row, type } = buildAdjustmentRow(line, ctx);
    expect(type).toBe("found");
    expect(row.adjustment_type).toBe("found");
    expect(row.qty_delta).toBe(10);
    expect(row.unit_cost_cents).toBe(1500);
    expect(row.entity_id).toBe(ENTITY);
    expect(row.item_id).toBe(ITEM);
    expect(row.gl_account_id).toBe(GL_ACCT);
    expect(row.reason).toMatch(/Cycle count deadbeef/);
  });

  it("negative variance -> 'shrinkage' with NULL unit_cost_cents", () => {
    const line = { id: LINE, item_id: ITEM, system_qty: 100, counted_qty: 90, variance_qty: -10 };
    const { row, type } = buildAdjustmentRow(line, { ...ctx, unit_cost_cents_for_positive: null });
    expect(type).toBe("shrinkage");
    expect(row.adjustment_type).toBe("shrinkage");
    expect(row.qty_delta).toBe(-10);
    expect(row.unit_cost_cents).toBeNull();
  });

  it("preserves fractional variance qty", () => {
    const line = { id: LINE, item_id: ITEM, system_qty: 10, counted_qty: 10.5, variance_qty: 0.5 };
    const { row, type } = buildAdjustmentRow(line, ctx);
    expect(type).toBe("found");
    expect(row.qty_delta).toBe(0.5);
  });

  it("throws when counted_qty is null", () => {
    const line = { id: LINE, item_id: ITEM, system_qty: 10, counted_qty: null, variance_qty: null };
    expect(() => buildAdjustmentRow(line, ctx)).toThrow(/counted_qty/);
  });

  it("throws when variance is zero (caller should skip)", () => {
    const line = { id: LINE, item_id: ITEM, system_qty: 10, counted_qty: 10, variance_qty: 0 };
    expect(() => buildAdjustmentRow(line, ctx)).toThrow(/non-zero/);
  });
});

describe("finalize resolveUnitCostCents", () => {
  it("returns operator override when supplied", () => {
    const line = { id: LINE, item_id: ITEM };
    const cents = resolveUnitCostCents(line, { [LINE]: 2500 }, new Map());
    expect(cents).toBe(2500);
  });

  it("falls back to avg cost ($-denominated) × 100, rounded", () => {
    const line = { id: LINE, item_id: ITEM };
    const cents = resolveUnitCostCents(line, {}, new Map([[ITEM, 12.345]]));
    expect(cents).toBe(1235); // 12.345 × 100 = 1234.5 → 1235
  });

  it("returns null when no override and no avg cost", () => {
    const line = { id: LINE, item_id: ITEM };
    const cents = resolveUnitCostCents(line, {}, new Map());
    expect(cents).toBeNull();
  });

  it("override of 0 wins over avg cost", () => {
    const line = { id: LINE, item_id: ITEM };
    const cents = resolveUnitCostCents(line, { [LINE]: 0 }, new Map([[ITEM, 10]]));
    expect(cents).toBe(0);
  });

  it("rejects negative avg cost from db", () => {
    const line = { id: LINE, item_id: ITEM };
    const cents = resolveUnitCostCents(line, {}, new Map([[ITEM, -1]]));
    expect(cents).toBeNull();
  });

  it("rejects non-finite avg cost", () => {
    const line = { id: LINE, item_id: ITEM };
    expect(resolveUnitCostCents(line, {}, new Map([[ITEM, NaN]]))).toBeNull();
    expect(resolveUnitCostCents(line, {}, new Map([[ITEM, "abc"]]))).toBeNull();
  });
});

describe("finalize exceedsThreshold", () => {
  it("variance > pct of system -> true", () => {
    // 100 system, 15 variance = 15% > 10%
    expect(exceedsThreshold({ system_qty: 100, variance_qty: 15 }, 10)).toBe(true);
  });

  it("variance ≤ pct of system -> false", () => {
    // 100 system, 10 variance = exactly 10%, not strictly > 10%
    expect(exceedsThreshold({ system_qty: 100, variance_qty: 10 }, 10)).toBe(false);
    expect(exceedsThreshold({ system_qty: 100, variance_qty: 5 }, 10)).toBe(false);
  });

  it("negative variance breaches via absolute value", () => {
    expect(exceedsThreshold({ system_qty: 100, variance_qty: -25 }, 10)).toBe(true);
  });

  it("zero variance is never a breach", () => {
    expect(exceedsThreshold({ system_qty: 100, variance_qty: 0 }, 10)).toBe(false);
  });

  it("system=0 uses denominator floor of 1 to avoid div-by-zero", () => {
    // |3| / max(1,0) = 3 > 0.10 -> true
    expect(exceedsThreshold({ system_qty: 0, variance_qty: 3 }, 10)).toBe(true);
  });

  it("non-finite values are not a breach", () => {
    expect(exceedsThreshold({ system_qty: NaN, variance_qty: 10 }, 10)).toBe(false);
    expect(exceedsThreshold({ system_qty: 100, variance_qty: NaN }, 10)).toBe(false);
  });
});

describe("finalize variance fan-out — end-to-end shape", () => {
  // These tests cover the orchestrating pattern: given a set of variance lines
  // + an overrides map + avg costs, produce the parallel adjustment rows.
  // The handler does this loop inline, but we re-verify the shape here.
  function planFanout(lines, overrides, avgs, ctxBase) {
    const rows = [];
    const skipped = { zero: 0, notCounted: 0, missingCost: [] };
    for (const ln of lines) {
      if (ln.counted_qty == null) { skipped.notCounted++; continue; }
      const variance = Number(ln.variance_qty);
      if (!Number.isFinite(variance) || variance === 0) { skipped.zero++; continue; }
      let cost = null;
      if (variance > 0) {
        cost = resolveUnitCostCents(ln, overrides, avgs);
        if (cost == null) { skipped.missingCost.push(ln.id); continue; }
      }
      const { row } = buildAdjustmentRow(ln, { ...ctxBase, unit_cost_cents_for_positive: cost });
      rows.push(row);
    }
    return { rows, skipped };
  }

  const ctxBase = {
    entity_id: ENTITY,
    gl_account_id: GL_ACCT,
    cycle_count_id: CC_ID,
    cycle_count_short: "deadbeef",
  };

  it("produces 1 row per non-zero variance, skips zero + not-counted", () => {
    const lines = [
      { id: LINE,   item_id: ITEM,   system_qty: 100, counted_qty: 110, variance_qty: 10 },  // +10 found
      { id: LINE_B, item_id: ITEM_B, system_qty: 50,  counted_qty: 50,  variance_qty: 0 },   // zero
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", item_id: ITEM, system_qty: 30, counted_qty: null, variance_qty: null }, // not counted
    ];
    const out = planFanout(lines, {}, new Map([[ITEM, 5]]), ctxBase);
    expect(out.rows.length).toBe(1);
    expect(out.rows[0].adjustment_type).toBe("found");
    expect(out.rows[0].unit_cost_cents).toBe(500);
    expect(out.skipped.zero).toBe(1);
    expect(out.skipped.notCounted).toBe(1);
  });

  it("emits shrinkage row with null cost for negative variance, no avg needed", () => {
    const lines = [
      { id: LINE, item_id: ITEM, system_qty: 100, counted_qty: 90, variance_qty: -10 },
    ];
    const out = planFanout(lines, {}, new Map(), ctxBase);
    expect(out.rows.length).toBe(1);
    expect(out.rows[0].adjustment_type).toBe("shrinkage");
    expect(out.rows[0].qty_delta).toBe(-10);
    expect(out.rows[0].unit_cost_cents).toBeNull();
  });

  it("collects missing-cost line ids when positive variance has no override + no avg", () => {
    const lines = [
      { id: LINE, item_id: ITEM, system_qty: 100, counted_qty: 105, variance_qty: 5 },
    ];
    const out = planFanout(lines, {}, new Map(), ctxBase);
    expect(out.rows.length).toBe(0);
    expect(out.skipped.missingCost).toEqual([LINE]);
  });

  it("override beats avg even when both exist", () => {
    const lines = [
      { id: LINE, item_id: ITEM, system_qty: 100, counted_qty: 110, variance_qty: 10 },
    ];
    const out = planFanout(lines, { [LINE]: 9999 }, new Map([[ITEM, 5]]), ctxBase);
    expect(out.rows[0].unit_cost_cents).toBe(9999);
  });

  it("links rows back to source lines in stable order (parallel arrays)", () => {
    const lines = [
      { id: LINE,   item_id: ITEM,   system_qty: 100, counted_qty: 110, variance_qty: 10 },
      { id: LINE_B, item_id: ITEM_B, system_qty: 50,  counted_qty: 40,  variance_qty: -10 },
    ];
    const out = planFanout(lines, {}, new Map([[ITEM, 5]]), ctxBase);
    expect(out.rows.length).toBe(2);
    expect(out.rows[0].adjustment_type).toBe("found");
    expect(out.rows[1].adjustment_type).toBe("shrinkage");
  });
});
