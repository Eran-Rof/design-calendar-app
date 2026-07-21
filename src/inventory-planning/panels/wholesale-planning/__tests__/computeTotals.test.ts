// Unit tests for computeTotals — the pure aggregation behind the
// grid's totals strip + action / method chips.

import { describe, it, expect } from "vitest";
import { computeTotals, endingAtsTotal, endingOnHandTotal, histTrailingTotal, lastPeriodAtsTotal } from "../computeTotals";
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

describe("computeTotals", () => {
  it("sums final_forecast_qty across rows", () => {
    const t = computeTotals(
      [
        row({ forecast_id: "a", final_forecast_qty: 100 }),
        row({ forecast_id: "b", final_forecast_qty: 50 }),
        row({ forecast_id: "c", final_forecast_qty: 25 }),
      ],
      new Map(),
    );
    expect(t.final).toBe(175);
  });

  it("counts rows per recommended_action", () => {
    const t = computeTotals(
      [
        row({ recommended_action: "buy" }),
        row({ recommended_action: "buy" }),
        row({ recommended_action: "hold" }),
        row({ recommended_action: "expedite" }),
      ],
      new Map(),
    );
    expect(t.actions).toEqual({ buy: 2, hold: 1, expedite: 1 });
  });

  it("counts rows per forecast_method", () => {
    const t = computeTotals(
      [
        row({ forecast_method: "system" }),
        row({ forecast_method: "system" }),
        row({ forecast_method: "manual" }),
      ],
      new Map(),
    );
    expect(t.methods).toEqual({ system: 2, manual: 1 });
  });

  it("sums excess + shortage from skuPeriodMath, not from rows", () => {
    const t = computeTotals(
      [
        row({ projected_excess_qty: 99, projected_shortage_qty: 99 }),  // ignored
      ],
      new Map([
        ["sku1|2026-05", { excess: 10, shortage:  0 }],
        ["sku1|2026-06", { excess:  0, shortage:  5 }],
        ["sku2|2026-05", { excess:  4, shortage:  2 }],
      ]),
    );
    expect(t.excess).toBe(14);
    expect(t.shortage).toBe(7);
  });

  it("returns zeros for empty input", () => {
    const t = computeTotals([], new Map());
    // `columns` always carries the deduped supply totals (shortage/excess),
    // which are 0 for empty input but still present as keys. The `ats` key is
    // omitted entirely when there are no rows (mirrors the other supply keys).
    expect(t).toEqual({ final: 0, shortage: 0, excess: 0, actions: {}, methods: {}, columns: { shortage: 0, excess: 0 } });
  });

  // ── ATS column total: last-period-per-style/color, NOT sum-of-all-months ──

  it("ATS total takes only the last period of a single style/color (no month double-count)", () => {
    // One style/color rolling across 3 months. Summing all three would be
    // 300; the ending position is the June ATS = 60.
    const t = computeTotals(
      [
        row({ forecast_id: "a", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-04-01", period_code: "2026-04", available_supply_qty: 100 }),
        row({ forecast_id: "b", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 80 }),
        row({ forecast_id: "c", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
      ],
      new Map(),
    );
    expect(t.columns.ats).toBe(60);
  });

  it("ATS total sums the ending ATS across distinct style/color groups", () => {
    // Two style/colors, each rolling two months. Ending = 60 + 30 = 90.
    const t = computeTotals(
      [
        row({ forecast_id: "a", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 90 }),
        row({ forecast_id: "b", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
        row({ forecast_id: "c", sku_id: "s2", sku_style: "STY", sku_color: "BLU", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 50 }),
        row({ forecast_id: "d", sku_id: "s2", sku_style: "STY", sku_color: "BLU", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 30 }),
      ],
      new Map(),
    );
    expect(t.columns.ats).toBe(90);
  });

  it("ATS total sums sizes (distinct sku_ids) within a style/color's ending period", () => {
    // Same style/color, two sizes, each its own rolling pool. Ending period is
    // June for both → 60 (size S) + 25 (size M) = 85.
    const t = computeTotals(
      [
        row({ forecast_id: "a", sku_id: "s1", sku_style: "STY", sku_color: "RED", sku_size: "S", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 100 }),
        row({ forecast_id: "b", sku_id: "s1", sku_style: "STY", sku_color: "RED", sku_size: "S", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
        row({ forecast_id: "c", sku_id: "s2", sku_style: "STY", sku_color: "RED", sku_size: "M", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 40 }),
        row({ forecast_id: "d", sku_id: "s2", sku_style: "STY", sku_color: "RED", sku_size: "M", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 25 }),
      ],
      new Map(),
    );
    expect(t.columns.ats).toBe(85);
  });

  it("ATS total dedupes multi-customer rows in the ending period (one supply figure, not summed)", () => {
    // Same SKU + period appears on 3 customer rows carrying the SAME ATS
    // supply figure. It must count ONCE (60), not 3×60.
    const t = computeTotals(
      [
        row({ forecast_id: "a", sku_id: "s1", customer_id: "c1", sku_style: "STY", sku_color: "RED", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
        row({ forecast_id: "b", sku_id: "s1", customer_id: "c2", sku_style: "STY", sku_color: "RED", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
        row({ forecast_id: "c", sku_id: "s1", customer_id: "c3", sku_style: "STY", sku_color: "RED", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
      ],
      new Map(),
    );
    expect(t.columns.ats).toBe(60);
  });

  it("ATS total groups style/color case-insensitively and trimmed", () => {
    // "STY"/"Red" and " sty "/" RED " are the same group → one ending period,
    // deduped per sku → 70 (not 140).
    const t = computeTotals(
      [
        row({ forecast_id: "a", sku_id: "s1", sku_style: "STY", sku_color: "Red", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 70 }),
        row({ forecast_id: "b", sku_id: "s1", sku_style: " sty ", sku_color: " RED ", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 70 }),
      ],
      new Map(),
    );
    expect(t.columns.ats).toBe(70);
  });

  it("ATS total follows the filtered window (last period = max in view)", () => {
    // Same rows as the single-style test but the June row filtered out of the
    // view — the ending period becomes May, so the total is the May ATS (80).
    const inView = [
      row({ forecast_id: "a", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-04-01", period_code: "2026-04", available_supply_qty: 100 }),
      row({ forecast_id: "b", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 80 }),
    ];
    expect(lastPeriodAtsTotal(inView)).toBe(80);
    expect(computeTotals(inView, new Map()).columns.ats).toBe(80);
  });

  it("lastPeriodAtsTotal returns 0 for empty input", () => {
    expect(lastPeriodAtsTotal([])).toBe(0);
  });
});


// ── endingAtsTotal — display-parity ATS total over ROLLED rows ──────────
// CEO spec (2026-07-21): "RYB0412PPK Black has 5000 ATS in the last period
// -> add that amount to the next style and so on." The total reads the
// LAST row's displayed (rolled) ATS of each chain and sums — it can never
// be 0 while the cells show numbers.
describe("endingAtsTotal", () => {
  const byStyleColor = (r: IpPlanningGridRow) =>
    `sku:${r.sku_style ?? r.sku_code}:${r.sku_color ?? "—"}`;

  it("single chain returns its last row's ATS (not the sum of periods)", () => {
    const rows = [
      row({ forecast_id: "a", sku_color: "Black", period_start: "2027-01-01", available_supply_qty: 2000 }),
      row({ forecast_id: "b", sku_color: "Black", period_start: "2027-02-01", available_supply_qty: 3500 }),
      row({ forecast_id: "c", sku_color: "Black", period_start: "2027-03-01", available_supply_qty: 5000 }),
    ];
    expect(endingAtsTotal(rows, byStyleColor)).toBe(5000);
  });

  it("sums the ending ATS across chains (style then next style)", () => {
    const rows = [
      row({ forecast_id: "a", sku_style: "RYB0412PPK", sku_color: "Black", period_start: "2027-05-01", available_supply_qty: 4000 }),
      row({ forecast_id: "b", sku_style: "RYB0412PPK", sku_color: "Black", period_start: "2027-06-01", available_supply_qty: 5000 }),
      row({ forecast_id: "c", sku_style: "RYB0185", sku_color: "Charcoal", period_start: "2027-05-01", available_supply_qty: 120 }),
      row({ forecast_id: "d", sku_style: "RYB0185", sku_color: "Charcoal", period_start: "2027-06-01", available_supply_qty: 80 }),
    ];
    expect(endingAtsTotal(rows, byStyleColor)).toBe(5080);
  });

  it("rolled input beats raw zeros — the #1862 defect case", () => {
    // Customer-demand rows carry raw available_supply_qty 0; after the
    // rolling pool the DISPLAYED values are nonzero. Totalling the rolled
    // rows yields the on-screen ending figure, never 0.
    const rolled = [
      row({ forecast_id: "a", sku_color: "Black", period_start: "2027-01-01", available_supply_qty: 900 }),
      row({ forecast_id: "b", sku_color: "Black", period_start: "2027-02-01", available_supply_qty: 750 }),
    ];
    expect(endingAtsTotal(rolled, byStyleColor)).toBe(750);
  });

  it("non-consecutive same key = ONE logical chain (Period-sort interleave)", () => {
    // A Period sort interleaves chains (Mar/Black, Mar/White, Apr/Black…).
    // The chain is LOGICAL — grouped by key regardless of position — so
    // Black's ending is its latest-period row, not one per visual run.
    const rows = [
      row({ forecast_id: "a", sku_color: "Black", period_start: "2027-03-01", available_supply_qty: 10 }),
      row({ forecast_id: "b", sku_color: "White", period_start: "2027-03-01", available_supply_qty: 20 }),
      row({ forecast_id: "c", sku_color: "Black", period_start: "2027-04-01", available_supply_qty: 30 }),
    ];
    expect(endingAtsTotal(rows, byStyleColor)).toBe(50);
  });

  it("same-period tie inside a chain: the later row wins (chronological roll order)", () => {
    const rows = [
      row({ forecast_id: "a", sku_color: "Black", period_start: "2027-03-01", available_supply_qty: 10 }),
      row({ forecast_id: "b", sku_color: "Black", period_start: "2027-03-01", available_supply_qty: 40 }),
    ];
    expect(endingAtsTotal(rows, byStyleColor)).toBe(40);
  });

  it("empty input totals 0", () => {
    expect(endingAtsTotal([], byStyleColor)).toBe(0);
  });
});

describe("computeTotals — atsTotal override (display parity)", () => {
  it("uses the provided rolled ATS total over the raw-row fallback", () => {
    const rows = [
      row({ forecast_id: "a", period_start: "2027-06-01", available_supply_qty: 0 }),
    ];
    const t = computeTotals(rows, new Map(), { atsTotal: 5080 });
    expect(t.columns.ats).toBe(5080);
  });

  it("falls back to lastPeriodAtsTotal when no override is provided", () => {
    const rows = [
      row({ forecast_id: "a", period_start: "2027-05-01", available_supply_qty: 111 }),
      row({ forecast_id: "b", period_start: "2027-06-01", available_supply_qty: 222 }),
    ];
    const t = computeTotals(rows, new Map());
    expect(t.columns.ats).toBe(222);
  });

  it("keeps the empty-input columns shape (no ats key) even with an override", () => {
    const t = computeTotals([], new Map(), { atsTotal: 999 });
    expect("ats" in t.columns).toBe(false);
  });
});


describe("endingOnHandTotal + onHandTotal override", () => {
  const byStyleColor2 = (r: IpPlanningGridRow) =>
    `sku:${r.sku_style ?? r.sku_code}:${r.sku_color ?? "-"}`;

  it("sums each chain's latest-period displayed On Hand", () => {
    const rows = [
      row({ forecast_id: "a", sku_color: "Black", period_start: "2027-03-01", on_hand_qty: 0 }),
      row({ forecast_id: "b", sku_color: "Black", period_start: "2027-04-01", on_hand_qty: 1200 }),
      row({ forecast_id: "c", sku_color: "White", period_start: "2027-04-01", on_hand_qty: 500 }),
    ];
    expect(endingOnHandTotal(rows, byStyleColor2)).toBe(1700);
  });

  it("computeTotals uses the onHandTotal override over the raw dedupe-sum", () => {
    const rows = [
      row({ forecast_id: "a", period_start: "2027-03-01", period_code: "2027-03", on_hand_qty: 0 }),
      row({ forecast_id: "b", period_start: "2027-04-01", period_code: "2027-04", on_hand_qty: 0 }),
    ];
    const t = computeTotals(rows, new Map(), { onHandTotal: 1200 });
    expect(t.columns.onHand).toBe(1200);
  });

  it("without the override the raw dedupe-sum behavior is unchanged", () => {
    const rows = [
      row({ forecast_id: "a", period_start: "2027-03-01", period_code: "2027-03", on_hand_qty: 70 }),
      row({ forecast_id: "b", period_start: "2027-04-01", period_code: "2027-04", on_hand_qty: 30 }),
    ];
    const t = computeTotals(rows, new Map());
    expect(t.columns.onHand).toBe(100);
  });
});


describe("histTrailingTotal -- trailing window counted once per line", () => {
  it("counts a (customer, sku) line ONCE across its period rows (latest wins)", () => {
    const rows = [
      row({ forecast_id: "a", customer_id: "c1", sku_id: "s1", period_start: "2027-03-01", historical_trailing_qty: 2600 }),
      row({ forecast_id: "b", customer_id: "c1", sku_id: "s1", period_start: "2027-04-01", historical_trailing_qty: 2673 }),
      row({ forecast_id: "c", customer_id: "c1", sku_id: "s1", period_start: "2027-05-01", historical_trailing_qty: 2673 }),
    ];
    expect(histTrailingTotal(rows)).toBe(2673);
  });

  it("sums across distinct customer+sku lines", () => {
    const rows = [
      row({ forecast_id: "a", customer_id: "c1", sku_id: "s1", historical_trailing_qty: 6337 }),
      row({ forecast_id: "b", customer_id: "c1", sku_id: "s2", historical_trailing_qty: 4025 }),
      row({ forecast_id: "c", customer_id: "c2", sku_id: "s1", historical_trailing_qty: 100 }),
    ];
    expect(histTrailingTotal(rows)).toBe(10462);
  });

  it("keys TBD stock-buy rows separately from a forecast row sharing the sku", () => {
    const rows = [
      row({ forecast_id: "a", customer_id: "c1", sku_id: "s1", historical_trailing_qty: 500 }),
      row({ forecast_id: "tbd:1", customer_id: "c1", sku_id: "s1", is_tbd: true, historical_trailing_qty: 800 }),
    ];
    expect(histTrailingTotal(rows)).toBe(1300);
  });

  it("computeTotals exposes it as columns.histT3 (replacing the per-row sum)", () => {
    const rows = [
      row({ forecast_id: "a", customer_id: "c1", sku_id: "s1", period_start: "2027-03-01", period_code: "2027-03", historical_trailing_qty: 2673 }),
      row({ forecast_id: "b", customer_id: "c1", sku_id: "s1", period_start: "2027-04-01", period_code: "2027-04", historical_trailing_qty: 2673 }),
    ];
    const t = computeTotals(rows, new Map());
    expect(t.columns.histT3).toBe(2673);
  });
});
