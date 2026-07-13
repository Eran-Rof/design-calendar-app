// Unit tests for computeContentLengths — the pure row-scan that feeds
// computeColumnWidth. Only need a couple of cases here: header-floor
// is always applied, the longest row value wins per column, null
// values render as "—" (1 char), money + qty format adds digits/commas.

import { describe, it, expect } from "vitest";
import { computeContentLengths } from "../computeContentLengths";
import { COLUMN_LABEL } from "../columns";
import type { IpPlanningGridRow } from "../../../types/wholesale";

function row(over: Partial<IpPlanningGridRow> = {}): IpPlanningGridRow {
  return {
    forecast_id: "f1",
    sku_id: "s1", sku_code: "S1", sku_style: "S1", sku_color: null, sku_size: null,
    sku_description: null, group_name: null, sub_category_name: null, category_id: null,
    customer_id: null, customer_name: null, channel_id: null,
    period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
    abc_class: null, xyz_class: null,
    historical_trailing_qty: null, ly_reference_qty: null, historical_margin_pct: null, historical_receipts_qty: null,
    system_forecast_qty: 0, buyer_request_qty: 0, override_qty: 0,
    final_forecast_qty: 0,
    confidence_level: null, forecast_method: "system",
    on_hand_qty: null, on_so_qty: 0, on_po_qty: null, receipts_due_qty: null,
    available_supply_qty: 0, planned_buy_qty: null,
    avg_cost: null, ats_avg_cost: null, item_cost: null, unit_cost: null, unit_cost_override: null,
    projected_shortage_qty: null, projected_excess_qty: null,
    recommended_action: "hold",
    ...over,
  } as IpPlanningGridRow;
}

describe("computeContentLengths", () => {
  it("seeds every column with header-label length + 1 (sort glyph)", () => {
    const lens = computeContentLengths([]);
    for (const k of Object.keys(COLUMN_LABEL)) {
      expect(lens[k]).toBe(COLUMN_LABEL[k].length + 1);
    }
  });

  it("uses the longest row value when it exceeds the header floor", () => {
    const long = "This is a very long description that exceeds the header";
    const lens = computeContentLengths([
      row({ sku_description: long }),
      row({ sku_description: "short" }),
    ]);
    expect(lens.description).toBe(long.length);
  });

  it("falls back to '—' (1 char) for null content — header floor wins", () => {
    const lens = computeContentLengths([row({ sku_description: null })]);
    // "Description" header is 11 chars + 1 glyph = 12, beats "—" (1).
    expect(lens.description).toBe(12);
  });

  it("treats money cells with $ sign + 2-decimal formatting", () => {
    const lens = computeContentLengths([row({ unit_cost: 12345.678 })]);
    // "$12345.68" = 9 chars; header "Unit Cost" = 9 + 1 = 10. Header wins.
    expect(lens.unitCost).toBe(10);
    // But $1,234,567.89-style content beats the header
    const big = computeContentLengths([row({ unit_cost: 99_999_999.99 })]);
    expect(big.unitCost).toBeGreaterThan(10);
  });

  it("style column reads sku_style with fallback to sku_code", () => {
    const lens = computeContentLengths([
      row({ sku_style: null, sku_code: "FALLBACK_LONG_CODE" }),
    ]);
    expect(lens.style).toBe("FALLBACK_LONG_CODE".length);
  });

  it("buyDollars column derives from planned_buy_qty * unit_cost", () => {
    const lens = computeContentLengths([
      row({ planned_buy_qty: 1000, unit_cost: 9.99 }),
    ]);
    // 1000 * 9.99 = 9990.00 → "$9990.00" = 8 chars; header "Buy $" = 5 + 1 = 6.
    expect(lens.buyDollars).toBe(8);
  });

  it("reserves extra Customer width for planner-added rows (Add-to-DB + ✕ controls)", () => {
    const name = "Burlington Coat Factory"; // 23 chars
    const plain = computeContentLengths([row({ customer_name: name })]);
    const added = computeContentLengths([
      row({ customer_name: name, is_tbd: true, is_user_added: true }),
    ]);
    // A plain row sizes to the name; a planner-added row reserves +16 chars
    // for the Add-to-DB / ✕ controls the Customer cell renders.
    expect(plain.customer).toBe(name.length);
    expect(added.customer).toBe(name.length + 16);
  });

  it("does NOT reserve control width on aggregate rows", () => {
    const name = "Burlington Coat Factory";
    const agg = computeContentLengths([
      row({ customer_name: name, is_tbd: true, is_user_added: true, is_aggregate: true }),
    ]);
    // Aggregate rows don't render the per-row controls, so no reserve.
    expect(agg.customer).toBe(name.length);
  });
});
