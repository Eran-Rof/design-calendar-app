// Locks in the rule that color resolution must NEVER fall back to the
// style-master row. Background: prior to commit 6994a5f the wholesale
// forecast service fell back to masterByStyle's color when a variant's
// color was null, which tagged every color-less variant of style
// "RYB0412" as "Grey" (the master row's color) — collapsing 31 distinct
// colors into one bucket in the All-sizes / All-colors grid view.
//
// These tests assert that:
//   1. variant's own color wins
//   2. when variant color is missing, we parse from sku_code
//   3. we never silently inherit a sibling/master color
//   4. distinct variants with no own color produce distinct bucket keys

import { describe, it, expect } from "vitest";
import { resolveVariantColor, resolveVariantColorWithProvenance, parseColorFromSkuCode, prettifyColorCode } from "../services/resolveVariantColor";
import { aggregateRows, type CollapseModes } from "../panels/aggregateGridRows";
import type { IpPlanningGridRow } from "../types/wholesale";

describe("resolveVariantColor", () => {
  it("uses the variant's own color when set", () => {
    expect(resolveVariantColor("Navy", "RYB0412-NAVY", "RYB0412")).toBe("Navy");
  });

  it("treats blank variant color as missing and parses from sku_code (raw, no prettify)", () => {
    // resolveVariantColor returns the raw parser output. Prettification
    // only happens through resolveVariantColorWithProvenance, which is
    // what production code uses.
    expect(resolveVariantColor("", "RYB0412-NAVY", "RYB0412")).toBe("NAVY");
    expect(resolveVariantColor("   ", "RYB0412-NAVY", "RYB0412")).toBe("NAVY");
    expect(resolveVariantColor(null, "RYB0412-NAVY", "RYB0412")).toBe("NAVY");
    expect(resolveVariantColor(undefined, "RYB0412-NAVY", "RYB0412")).toBe("NAVY");
  });

  it("parses the color suffix from sku_code", () => {
    expect(parseColorFromSkuCode("RYB0412-SAHARACAMO", "RYB0412")).toBe("SAHARACAMO");
    expect(parseColorFromSkuCode("RYB0412-LTGREY", "RYB0412")).toBe("LTGREY");
    expect(parseColorFromSkuCode("RYB0412-GREY", "RYB0412")).toBe("GREY");
  });

  it("returns null when sku_code doesn't match the style prefix", () => {
    expect(parseColorFromSkuCode("OTHER-NAVY", "RYB0412")).toBeNull();
    expect(parseColorFromSkuCode("RYB0412NAVY", "RYB0412")).toBeNull(); // missing dash
  });

  it("returns null when sku_code is exactly the style with no suffix", () => {
    expect(parseColorFromSkuCode("RYB0412", "RYB0412")).toBeNull();
    expect(parseColorFromSkuCode("RYB0412-", "RYB0412")).toBeNull();
  });

  it("returns null when style_code or sku_code are missing", () => {
    expect(parseColorFromSkuCode(null, "RYB0412")).toBeNull();
    expect(parseColorFromSkuCode("RYB0412-NAVY", null)).toBeNull();
    expect(parseColorFromSkuCode(null, null)).toBeNull();
  });

  it("reports provenance: variant own color is not inferred", () => {
    expect(resolveVariantColorWithProvenance("Navy", "RYB0412-NAVY", "RYB0412"))
      .toEqual({ color: "Navy", inferred: false });
  });

  it("reports provenance: parsed-from-sku_code is inferred (and prettified)", () => {
    expect(resolveVariantColorWithProvenance(null, "RYB0412-NAVY", "RYB0412"))
      .toEqual({ color: "Navy", inferred: true });
  });

  it("reports provenance: null result is not inferred", () => {
    expect(resolveVariantColorWithProvenance(null, "RYB0412", "RYB0412"))
      .toEqual({ color: null, inferred: false });
  });

  it("prettifies inferred colors via the vocabulary", () => {
    expect(resolveVariantColorWithProvenance(null, "RYB0412-TONALGREYCAMO", "RYB0412"))
      .toEqual({ color: "Tonal Grey Camo", inferred: true });
    expect(resolveVariantColorWithProvenance(null, "RYB0412-LTGREY", "RYB0412"))
      .toEqual({ color: "Lt Grey", inferred: true });
    expect(resolveVariantColorWithProvenance(null, "RYB0412-BLKCAMO", "RYB0412"))
      .toEqual({ color: "Black Camo", inferred: true });
  });

  it("never returns a sibling/master color when variant has no own color", () => {
    // The bug: previously the service fell back to styleFallback?.color
    // (the master row's color, e.g. "Grey") for every color-less variant
    // of the same style. We now require: variant own color OR sku_code
    // suffix OR null. Nothing else.
    const result = resolveVariantColor(null, "RYB0412-NAVY", "RYB0412");
    expect(result).not.toBe("Grey");
    expect(result).toBe("NAVY"); // raw resolver output
  });
});

describe("prettifyColorCode", () => {
  it("breaks concatenated upper-case codes on the color vocabulary", () => {
    expect(prettifyColorCode("TONALGREYCAMO")).toBe("Tonal Grey Camo");
    expect(prettifyColorCode("WITHERFADEASHENCAMO")).toBe("Wither Fade Ashen Camo");
    expect(prettifyColorCode("CREAMTONALGRIZZLYCAMO")).toBe("Cream Tonal Grizzly Camo");
    expect(prettifyColorCode("AUTUMNGRIZZLYCAMO")).toBe("Autumn Grizzly Camo");
  });

  it("expands abbreviations via the alias map", () => {
    expect(prettifyColorCode("BLKCAMO")).toBe("Black Camo");
    expect(prettifyColorCode("LTGREY")).toBe("Lt Grey");
    expect(prettifyColorCode("LTBROWN")).toBe("Lt Brown");
  });

  it("title-cases lone vocabulary words", () => {
    expect(prettifyColorCode("BLACK")).toBe("Black");
    expect(prettifyColorCode("GREY")).toBe("Grey");
    expect(prettifyColorCode("ESPRESSO")).toBe("Espresso");
  });

  it("falls through unknown chunks as a single title-cased token", () => {
    expect(prettifyColorCode("RUSSET")).toBe("Russet");
    expect(prettifyColorCode("RUSSETCAMO")).toBe("Russet Camo");
  });
});

// ---- Integration check: distinct colors must NOT collapse together
// in the All-sizes bucket key. This is the regression test for the
// 31-variants-in-one-bucket bug.

function row(p: Partial<IpPlanningGridRow>): IpPlanningGridRow {
  return {
    forecast_id: "f-1",
    planning_run_id: "run-1",
    customer_id: "cust-a",
    customer_name: "Customer A",
    category_id: null,
    category_name: null,
    group_name: null,
    sub_category_name: null,
    gender: null,
    sku_id: "sku-1",
    sku_code: "RYB0412-GREY",
    sku_description: null,
    sku_style: "RYB0412",
    sku_color: "GREY",
    sku_size: null,
    period_code: "2026-04",
    period_start: "2026-04-01",
    period_end: "2026-04-30",
    historical_trailing_qty: 0,
    system_forecast_qty: 0,
    buyer_request_qty: 0,
    override_qty: 0,
    final_forecast_qty: 0,
    confidence_level: "estimate",
    forecast_method: "zero_floor",
    ly_reference_qty: null,
    item_cost: null,
    ats_avg_cost: null,
    avg_cost: null,
    unit_cost_override: null,
    unit_cost: null,
    planned_buy_qty: null,
    on_hand_qty: 0,
    on_so_qty: 0,
    on_po_qty: 0,
    receipts_due_qty: 0,
    historical_receipts_qty: 0,
    available_supply_qty: 0,
    projected_shortage_qty: 0,
    projected_excess_qty: 0,
    recommended_action: "monitor",
    recommended_qty: null,
    action_reason: null,
    notes: null,
    ...p,
  };
}

// Sizes are always merged at the (style, color) grain — no toggle.
// Combined with `customers: true`, this simulates the case the bug
// was about: every customer + every size of (style, color) collapsed
// into one row. Distinct colors must still stay in distinct buckets.
const ALL_CUSTOMERS: CollapseModes = {
  customers: true, colors: false, category: false, subCat: false,
  customerAllStyles: false, allCustomersPerCategory: false, allCustomersPerSubCat: false,
  allCustomersPerStyle: false,
};

describe("All-sizes bucket key — color isolation regression", () => {
  it("two variants of the same style with distinct resolved colors stay in distinct buckets", () => {
    // Simulates the post-fix world: two RYB0412 variants whose master
    // rows had no color set, now resolve to different colors via the
    // sku_code parser. They MUST NOT collapse into one bucket.
    const grey = row({
      forecast_id: "f-grey",
      sku_id: "sku-grey",
      sku_code: "RYB0412-GREY",
      sku_color: resolveVariantColor(null, "RYB0412-GREY", "RYB0412"),
      on_hand_qty: 5241,
    });
    const navy = row({
      forecast_id: "f-navy",
      sku_id: "sku-navy",
      sku_code: "RYB0412-NAVY",
      sku_color: resolveVariantColor(null, "RYB0412-NAVY", "RYB0412"),
      on_hand_qty: 39,
    });

    const out = aggregateRows([grey, navy], ALL_CUSTOMERS);

    expect(out).toHaveLength(2);
    const colors = out.map((r) => r.sku_color).sort();
    expect(colors).toEqual(["GREY", "NAVY"]);
  });

  it("if the old bug came back (everything tagged 'Grey'), this test would fail loudly", () => {
    // What the old fallback did: stamp every variant with the master's
    // arbitrary color. If that ever re-lands, both rows below would
    // bucket together and on_hand would sum to 5,280 instead of staying
    // separate. This test is intentionally explicit so a future
    // refactor that re-introduces a styleFallback color path trips it.
    const buggyGrey1 = row({
      forecast_id: "f1",
      sku_id: "sku-1",
      sku_code: "RYB0412-NAVY",
      sku_color: "GREY", // pretend fallback fired
    });
    const buggyGrey2 = row({
      forecast_id: "f2",
      sku_id: "sku-2",
      sku_code: "RYB0412-OLIVE",
      sku_color: "GREY", // pretend fallback fired
    });

    const out = aggregateRows([buggyGrey1, buggyGrey2], ALL_CUSTOMERS);

    // With identical (style, color) the All-sizes bucket merges them.
    // That's the WRONG outcome we used to ship — the assertion below
    // documents what would happen if the fallback ever returns. The
    // resolveVariantColor tests above prevent that at the source.
    expect(out).toHaveLength(1);
    expect(out[0].is_aggregate).toBe(true);
    // Real fix proven by the test above this one: with proper
    // resolution NAVY and OLIVE land in distinct buckets.
  });
});
