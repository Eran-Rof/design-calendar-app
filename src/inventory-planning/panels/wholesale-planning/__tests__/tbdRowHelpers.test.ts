// Tests for the TBD row helpers. These pin two non-obvious rules:
//   1. "NEW style" detection — any style not in masterStyles, not
//      blank, not "TBD", whether it came from a sibling TBD row or
//      not.
//   2. "Block color edit on non-first rows of a NEW-style family" —
//      mirrors the workbench's save-side `isFirstRowOfNewStyle`.
//      Drift between UI gate + save gate = silently saving the wrong
//      row's edits.

import { describe, it, expect } from "vitest";
import { buildStyleCellContext, buildColorCellContext, type MasterStyle } from "../tbdRowHelpers";
import type { IpPlanningGridRow } from "../../../types/wholesale";

function row(over: Partial<IpPlanningGridRow> = {}): IpPlanningGridRow {
  return {
    forecast_id: "f1",
    sku_id: "s1", sku_code: "S1", sku_style: "S1", sku_color: null, sku_size: null,
    sku_description: null, group_name: null, sub_category_name: null, category_id: null,
    customer_id: null, customer_name: null, channel_id: null,
    period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
    abc_class: null, xyz_class: null,
    historical_trailing_qty: 0, ly_reference_qty: 0, historical_margin_pct: null, historical_receipts_qty: 0,
    system_forecast_qty: 0, buyer_request_qty: 0, override_qty: 0,
    final_forecast_qty: 0,
    confidence_level: "", forecast_method: "system",
    on_hand_qty: 0, on_so_qty: 0, on_po_qty: 0, receipts_due_qty: 0,
    available_supply_qty: 0, planned_buy_qty: 0,
    avg_cost: null, ats_avg_cost: null, item_cost: null, unit_cost: null, unit_cost_override: null,
    projected_shortage_qty: 0, projected_excess_qty: 0,
    recommended_action: "hold",
    ...over,
  } as IpPlanningGridRow;
}

const ms = (style_code: string, group_name: string | null = null): MasterStyle =>
  ({ style_code, group_name, sub_category_name: null });

// ────────────────────────────────────────────────────────────────────────

describe("buildStyleCellContext", () => {
  it("returns 'TBD' as the styleVal when sku_style is null", () => {
    const ctx = buildStyleCellContext(row({ sku_style: null }), [], []);
    expect(ctx.styleVal).toBe("TBD");
    expect(ctx.isNewStyle).toBe(false); // 'TBD' is never NEW
  });

  it("flags isNewStyle=true for a style absent from master + not 'TBD'", () => {
    const r = row({ sku_style: "RYB999" });
    const ctx = buildStyleCellContext(r, [r], [ms("OLD123")]);
    expect(ctx.isNewStyle).toBe(true);
  });

  it("flags isNewStyle=false for master-known styles", () => {
    const r = row({ sku_style: "RYB001" });
    const ctx = buildStyleCellContext(r, [r], [ms("RYB001")]);
    expect(ctx.isNewStyle).toBe(false);
  });

  it("style comparison is case-insensitive", () => {
    const r = row({ sku_style: "ryb001" });
    const ctx = buildStyleCellContext(r, [r], [ms("RYB001")]);
    expect(ctx.isNewStyle).toBe(false);
  });

  it("includes planner-added NEW styles in categoryStyles + allStylesLower", () => {
    const rA = row({ forecast_id: "a", sku_style: "RYB999", is_tbd: true });
    const rB = row({ forecast_id: "b", sku_style: "RYBxyz", is_tbd: true });
    const rOther = row({ forecast_id: "c", sku_style: "RYB001", is_tbd: false });
    const allRows = [rA, rB, rOther];
    const ctx = buildStyleCellContext(rA, allRows, [ms("RYB001")]);
    // RYB001 is master; RYB999 + RYBxyz are planner-added; both should appear
    expect(ctx.categoryStyles).toContain("RYB001");
    expect(ctx.categoryStyles).toContain("RYBxyz");
    expect(ctx.allStylesLower.has("rybxyz")).toBe(true);
    expect(ctx.allStylesLower.has("ryb001")).toBe(true);
  });

  it("filters master styles by group_name when row has one", () => {
    const r = row({ sku_style: "X", group_name: "Tops" });
    const ctx = buildStyleCellContext(r, [r], [ms("M1", "Tops"), ms("M2", "Bottoms"), ms("M3", "Tops")]);
    expect(ctx.categoryStyles).toContain("M1");
    expect(ctx.categoryStyles).toContain("M3");
    expect(ctx.categoryStyles).not.toContain("M2");
  });

  it("includes every master style when row.group_name is null", () => {
    const r = row({ sku_style: "X", group_name: null });
    const ctx = buildStyleCellContext(r, [r], [ms("M1", "Tops"), ms("M2", "Bottoms")]);
    expect(ctx.categoryStyles).toContain("M1");
    expect(ctx.categoryStyles).toContain("M2");
  });

  it("excludes TBD-literal placeholder rows from userAddedStyles", () => {
    const rA = row({ forecast_id: "a", sku_style: "TBD", is_tbd: true });
    const rTarget = row({ forecast_id: "b", sku_style: "NEW1", is_tbd: true });
    const ctx = buildStyleCellContext(rTarget, [rA, rTarget], [ms("OLD")]);
    expect(ctx.categoryStyles).toContain("NEW1");
    expect(ctx.categoryStyles).not.toContain("TBD");
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("buildColorCellContext — isNewForStyle", () => {
  const masterStyles = [ms("S1")];

  it("true when color is in master pool but NOT in this style's master colors", () => {
    const r = row({ sku_style: "S1", sku_color: "Blue", is_tbd: true, is_new_color: false });
    const ctx = buildColorCellContext(
      r, [r], masterStyles,
      new Set(["blue", "red"]),       // allKnownColorsLower
      new Set(["blue"]),               // masterColorsLower
      new Map([["S1", new Set(["red"])]]),  // S1 doesn't have blue
    );
    expect(ctx.isNewForStyle).toBe(true);
  });

  it("false when color IS in this style's master colors", () => {
    const r = row({ sku_style: "S1", sku_color: "Red", is_tbd: true, is_new_color: false });
    const ctx = buildColorCellContext(
      r, [r], masterStyles,
      new Set(["red"]),
      new Set(["red"]),
      new Map([["S1", new Set(["red"])]]),
    );
    expect(ctx.isNewForStyle).toBe(false);
  });

  it("false when is_new_color is already set (orange badge takes precedence)", () => {
    const r = row({ sku_style: "S1", sku_color: "Blue", is_tbd: true, is_new_color: true });
    const ctx = buildColorCellContext(
      r, [r], masterStyles,
      new Set(["blue"]), new Set(["blue"]), new Map(),
    );
    expect(ctx.isNewForStyle).toBe(false);
  });

  it("false for 'TBD' placeholder color", () => {
    const r = row({ sku_style: "S1", sku_color: "TBD", is_tbd: true });
    const ctx = buildColorCellContext(
      r, [r], masterStyles, new Set(), new Set(), new Map(),
    );
    expect(ctx.isNewForStyle).toBe(false);
  });
});

describe("buildColorCellContext — blockColorEdit", () => {
  it("false when row's style is master-known (always edit freely)", () => {
    const r = row({ forecast_id: "a", sku_style: "S1", is_tbd: true });
    const ctx = buildColorCellContext(
      r, [r], [ms("S1")], new Set(), new Set(), new Map(),
    );
    expect(ctx.blockColorEdit).toBe(false);
  });

  it("false for NEW-style orphan rows (family.length === 1)", () => {
    const r = row({ forecast_id: "a", sku_style: "NEW1", tbd_id: "t1", is_tbd: true });
    const ctx = buildColorCellContext(
      r, [r], [], new Set(), new Set(), new Map(),
    );
    expect(ctx.blockColorEdit).toBe(false);
  });

  it("false on the FIRST row of a NEW-style family (earliest period_start, tied by tbd_id)", () => {
    const first = row({ forecast_id: "a", sku_style: "NEW1", tbd_id: "t1", is_tbd: true, period_start: "2026-04-01" });
    const second = row({ forecast_id: "b", sku_style: "NEW1", tbd_id: "t2", is_tbd: true, period_start: "2026-05-01" });
    const ctx = buildColorCellContext(
      first, [first, second], [], new Set(), new Set(), new Map(),
    );
    expect(ctx.blockColorEdit).toBe(false);
  });

  it("true on non-first rows of a NEW-style family", () => {
    const first = row({ forecast_id: "a", sku_style: "NEW1", tbd_id: "t1", is_tbd: true, period_start: "2026-04-01" });
    const second = row({ forecast_id: "b", sku_style: "NEW1", tbd_id: "t2", is_tbd: true, period_start: "2026-05-01" });
    const ctx = buildColorCellContext(
      second, [first, second], [], new Set(), new Set(), new Map(),
    );
    expect(ctx.blockColorEdit).toBe(true);
  });

  it("tie-break by tbd_id ascending when period_start matches", () => {
    const a = row({ forecast_id: "a", sku_style: "NEW1", tbd_id: "tA", is_tbd: true, period_start: "2026-04-01" });
    const b = row({ forecast_id: "b", sku_style: "NEW1", tbd_id: "tB", is_tbd: true, period_start: "2026-04-01" });
    const ctxA = buildColorCellContext(a, [a, b], [], new Set(), new Set(), new Map());
    const ctxB = buildColorCellContext(b, [a, b], [], new Set(), new Set(), new Map());
    expect(ctxA.blockColorEdit).toBe(false); // tA wins tiebreak
    expect(ctxB.blockColorEdit).toBe(true);
  });

  it("false for 'TBD' literal style + blank style", () => {
    const r1 = row({ sku_style: "TBD", is_tbd: true });
    const r2 = row({ sku_style: "", is_tbd: true });
    const ctx1 = buildColorCellContext(r1, [r1], [], new Set(), new Set(), new Map());
    const ctx2 = buildColorCellContext(r2, [r2], [], new Set(), new Set(), new Map());
    expect(ctx1.blockColorEdit).toBe(false);
    expect(ctx2.blockColorEdit).toBe(false);
  });
});
