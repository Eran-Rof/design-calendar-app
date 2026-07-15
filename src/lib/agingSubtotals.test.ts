// src/lib/agingSubtotals.test.ts
import { describe, it, expect } from "vitest";
import {
  buildAgingDisplayList, aggregateRows, agingSortValue,
  type AgingRow, type AgingDisplayItem,
} from "./agingSubtotals";
import { carryingCost, weeksOfSupply } from "./inventoryAging";

// Minimal row factory — fills every AgingRow field, overridable per test.
function row(over: Partial<AgingRow>): AgingRow {
  return {
    grain_key: over.grain_key ?? `${over.style_code}-${over.color}-${over.size}`,
    grain_label: over.grain_label ?? "",
    style_code: null, color: null, size: null, gender: null,
    category_name: null, brand_name: null, vendor_name: null, location_name: null,
    on_hand_qty: 0, cost_value_cents: 0, avg_unit_cost_cents: 0,
    wavg_age_days: 0, oldest_age_days: 0, last_received: null,
    b1_qty: 0, b1_value_cents: 0, b2_qty: 0, b2_value_cents: 0,
    b3_qty: 0, b3_value_cents: 0, b4_qty: 0, b4_value_cents: 0,
    b5_qty: 0, b5_value_cents: 0, b6_qty: 0, b6_value_cents: 0,
    int_annual_cents: 0, sto_annual_cents: 0,
    carry_pct: 0, carry_per_unit_cents: 0,
    last_sold: null, days_since_last_sale: null,
    units_sold_90: null, weeks_of_supply: null, uncosted_qty: 0,
    ...over,
  };
}

const kinds = (list: AgingDisplayItem[]) => list.map((i) => i.kind);

describe("aggregateRows — subtotal math", () => {
  const members: AgingRow[] = [
    row({
      style_code: "RYB0412", color: "Red", on_hand_qty: 100, cost_value_cents: 50000,
      wavg_age_days: 40, oldest_age_days: 100, b1_qty: 100, b1_value_cents: 50000,
      int_annual_cents: 4500, sto_annual_cents: 231, last_received: "2026-01-10",
      last_sold: "2026-06-01", days_since_last_sale: 30, units_sold_90: 45, uncosted_qty: 0,
    }),
    row({
      style_code: "RYB0412", color: "Blue", on_hand_qty: 300, cost_value_cents: 90000,
      wavg_age_days: 200, oldest_age_days: 400, b5_qty: 300, b5_value_cents: 90000,
      int_annual_cents: 8100, sto_annual_cents: 694, last_received: "2026-03-15",
      last_sold: "2026-05-01", days_since_last_sale: 60, units_sold_90: null, uncosted_qty: 12,
    }),
  ];

  it("SUMs the additive measures", () => {
    const a = aggregateRows(members, { style_code: "RYB0412", color: null, size: null });
    expect(a.on_hand_qty).toBe(400);
    expect(a.cost_value_cents).toBe(140000);
    expect(a.uncosted_qty).toBe(12);
    expect(a.b1_value_cents).toBe(50000);
    expect(a.b5_value_cents).toBe(90000);
    expect(a.int_annual_cents).toBe(12600);
    expect(a.sto_annual_cents).toBe(925);
  });

  it("qty-weights average age and MAXes oldest", () => {
    const a = aggregateRows(members, { style_code: "RYB0412", color: null, size: null });
    expect(a.wavg_age_days).toBeCloseTo((100 * 40 + 300 * 200) / 400, 6);
    expect(a.oldest_age_days).toBe(400);
  });

  it("recomputes carry %/per-unit and weeks-of-supply from the summed values", () => {
    const a = aggregateRows(members, { style_code: "RYB0412", color: null, size: null });
    // carry_pct/per-unit derive from the SUMMED int+sto over the summed value/qty.
    expect(a.carry_pct).toBeCloseTo((12600 + 925) / 140000, 9);
    expect(a.carry_per_unit_cents).toBeCloseTo((12600 + 925) / 400, 9);
    expect(a.weeks_of_supply).toBe(weeksOfSupply(400, 45));
    expect(a.avg_unit_cost_cents).toBeCloseTo(140000 / 400, 9);
  });

  it("carry aggregate equals a fresh carryingCost() when members carry the canonical formula values", () => {
    // Two colors whose int/sto are the true ATS formula outputs → summing them
    // and recomputing equals carryingCost() on the summed totals exactly.
    const c1 = carryingCost(100, 50000);
    const c2 = carryingCost(300, 90000);
    const canon: AgingRow[] = [
      row({ style_code: "S", color: "R", on_hand_qty: 100, cost_value_cents: 50000, int_annual_cents: Math.round(c1.intAnnualCents), sto_annual_cents: Math.round(c1.stoAnnualCents) }),
      row({ style_code: "S", color: "B", on_hand_qty: 300, cost_value_cents: 90000, int_annual_cents: Math.round(c2.intAnnualCents), sto_annual_cents: Math.round(c2.stoAnnualCents) }),
    ];
    const a = aggregateRows(canon, { style_code: "S", color: null, size: null });
    const expected = carryingCost(400, 140000);
    expect(a.carry_pct).toBeCloseTo(expected.carryPct, 4);
    expect(a.carry_per_unit_cents).toBeCloseTo(expected.carryPerUnitCents, 2);
  });

  it("MAXes last_received / last_sold and MINs days-since-sale", () => {
    const a = aggregateRows(members, { style_code: "RYB0412", color: null, size: null });
    expect(a.last_received).toBe("2026-03-15");
    expect(a.last_sold).toBe("2026-06-01");
    expect(a.days_since_last_sale).toBe(30);
  });

  it("units_sold_90 is null only when EVERY member is null", () => {
    const a = aggregateRows(members, { style_code: "RYB0412", color: null, size: null });
    expect(a.units_sold_90).toBe(45); // one member had 45, other null → 45
    const allNull = aggregateRows(
      [row({ on_hand_qty: 10 }), row({ on_hand_qty: 20 })],
      { style_code: "X", color: null, size: null },
    );
    expect(allNull.units_sold_90).toBeNull();
    expect(allNull.weeks_of_supply).toBeNull();
  });
});

describe("buildAgingDisplayList — passthrough", () => {
  const rows = [
    row({ style_code: "A", color: "Red", on_hand_qty: 10, cost_value_cents: 100 }),
    row({ style_code: "B", color: "Blue", on_hand_qty: 20, cost_value_cents: 200 }),
  ];

  it("subtotals OFF → flat detail list, no subtotal rows", () => {
    const out = buildAgingDisplayList(rows, { groupBy: "style_color", sortKey: null, sortDir: "asc", subtotalsOn: false });
    expect(kinds(out)).toEqual(["detail", "detail"]);
  });

  it("non-applicable grouping → flat even with subtotals ON", () => {
    const out = buildAgingDisplayList(rows, { groupBy: "vendor", sortKey: null, sortDir: "asc", subtotalsOn: true });
    expect(kinds(out)).toEqual(["detail", "detail"]);
  });

  it("flat list still honors the active sort", () => {
    const out = buildAgingDisplayList(rows, { groupBy: "vendor", sortKey: "cost_value_cents", sortDir: "desc", subtotalsOn: true });
    expect(out.map((i) => i.row.cost_value_cents)).toEqual([200, 100]);
  });
});

describe("buildAgingDisplayList — style_color subtotals", () => {
  const rows = [
    row({ grain_key: "A-Red", style_code: "A", color: "Red", on_hand_qty: 10, cost_value_cents: 100 }),
    row({ grain_key: "A-Blue", style_code: "A", color: "Blue", on_hand_qty: 5, cost_value_cents: 900 }),
    row({ grain_key: "B-Green", style_code: "B", color: "Green", on_hand_qty: 3, cost_value_cents: 5000 }),
  ];

  it("interleaves one style_subtotal after each style's colors", () => {
    const out = buildAgingDisplayList(rows, { groupBy: "style_color", sortKey: null, sortDir: "asc", subtotalsOn: true });
    expect(kinds(out)).toEqual(["detail", "detail", "style_subtotal", "detail", "style_subtotal"]);
    // style A subtotal = 10+5 qty, 100+900 value
    const aSub = out[2];
    expect(aSub.label).toBe("A — subtotal");
    expect(aSub.row.on_hand_qty).toBe(15);
    expect(aSub.row.cost_value_cents).toBe(1000);
    // style B subtotal
    expect(out[4].label).toBe("B — subtotal");
    expect(out[4].row.cost_value_cents).toBe(5000);
  });

  it("orders styles by group total and colors within by the sort key", () => {
    const out = buildAgingDisplayList(rows, { groupBy: "style_color", sortKey: "cost_value_cents", sortDir: "desc", subtotalsOn: true });
    // B total 5000 > A total 1000 → B group first.
    expect(out[0].row.style_code).toBe("B");
    expect(out[1].kind).toBe("style_subtotal");
    // then A group: colors desc by value → Blue(900) before Red(100).
    expect(out[2].row.color).toBe("Blue");
    expect(out[3].row.color).toBe("Red");
    expect(out[4].kind).toBe("style_subtotal");
  });
});

describe("buildAgingDisplayList — sku subtotals", () => {
  const rows = [
    row({ grain_key: "A-Red-S", style_code: "A", color: "Red", size: "S", on_hand_qty: 10, cost_value_cents: 100 }),
    row({ grain_key: "A-Red-M", style_code: "A", color: "Red", size: "M", on_hand_qty: 20, cost_value_cents: 200 }),
    row({ grain_key: "A-Blue-S", style_code: "A", color: "Blue", size: "S", on_hand_qty: 4, cost_value_cents: 40 }),
    row({ grain_key: "B-Green-L", style_code: "B", color: "Green", size: "L", on_hand_qty: 7, cost_value_cents: 70 }),
  ];

  it("emits color subtotals per style+color AND a style subtotal per style", () => {
    const out = buildAgingDisplayList(rows, { groupBy: "sku", sortKey: null, sortDir: "asc", subtotalsOn: true });
    expect(kinds(out)).toEqual([
      "detail", "detail", "subtotal",       // A/Red sizes + Red subtotal
      "detail", "subtotal",                 // A/Blue size + Blue subtotal
      "style_subtotal",                     // A style subtotal
      "detail", "subtotal",                 // B/Green size + Green subtotal
      "style_subtotal",                     // B style subtotal
    ]);
    // A/Red color subtotal
    const redSub = out[2];
    expect(redSub.kind).toBe("subtotal");
    expect(redSub.label).toBe("Red — subtotal");
    expect(redSub.row.on_hand_qty).toBe(30);
    expect(redSub.row.cost_value_cents).toBe(300);
    // A style subtotal = all A rows
    const aStyle = out[5];
    expect(aStyle.kind).toBe("style_subtotal");
    expect(aStyle.label).toBe("A — subtotal");
    expect(aStyle.row.on_hand_qty).toBe(34);
    expect(aStyle.row.cost_value_cents).toBe(340);
  });

  it("subtotal rows carry a synthetic non-report grain_key (not clickable)", () => {
    const out = buildAgingDisplayList(rows, { groupBy: "sku", sortKey: null, sortDir: "asc", subtotalsOn: true });
    for (const it of out) {
      if (it.kind !== "detail") expect(it.row.grain_key.startsWith("subtotal:")).toBe(true);
    }
  });
});

describe("agingSortValue", () => {
  it("maps computed keys and falls back to scalar fields", () => {
    const r = row({ style_code: "Z", int_annual_cents: 100, sto_annual_cents: 25, weeks_of_supply: null, days_since_last_sale: null });
    expect(agingSortValue("carry_annual", r)).toBe(125);
    expect(agingSortValue("weeks_of_supply", r)).toBe(Number.MAX_SAFE_INTEGER);
    expect(agingSortValue("days_since_last_sale", r)).toBe(-1);
    expect(agingSortValue("style_code", r)).toBe("Z");
  });
});
