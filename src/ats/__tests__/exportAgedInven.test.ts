import { describe, it, expect } from "vitest";
import { exportAgedInven } from "../exportAgedInven";
import type { ATSRow } from "../types";

// Minimal ATSRow factory — only the fields exportAgedInven reads.
function row(over: Partial<ATSRow>): ATSRow {
  return {
    sku: "RYA0001 - Black",
    description: "TEST",
    category: "RAW FREEFORM CAT",        // raw feed category
    master_category: "BASEBALL CAP",      // item-master-resolved (dropdown value)
    gender: "M",
    store: "ROF",
    onHand: 100,
    onPO: 0,
    onOrder: 0,
    dates: {},
    freeMap: {},
    avgCost: 2,
    lastReceiptDate: undefined,           // → defaults to Sep 30 2024 → very aged
    ...over,
  } as ATSRow;
}

describe("exportAgedInven category filter", () => {
  it("matches the selected category against master_category (the dropdown value), not the raw r.category", () => {
    const rows = [row({})];
    // Selecting the master_category value (what the dropdown offers) finds the row.
    expect(exportAgedInven(rows, 240, "BASEBALL CAP")).not.toBe("empty");
    // Selecting the raw freeform category does NOT match (it's not a dropdown option).
    expect(exportAgedInven(rows, 240, "RAW FREEFORM CAT")).toBe("empty");
  });

  it("falls back to r.category when master_category is absent", () => {
    const rows = [row({ master_category: null })];
    expect(exportAgedInven(rows, 240, "RAW FREEFORM CAT")).not.toBe("empty");
  });

  it("'All' includes every category", () => {
    const rows = [row({ master_category: "BASEBALL CAP" }), row({ sku: "RYA0002 - Blue", master_category: "TEE" })];
    expect(exportAgedInven(rows, 240, "All")).not.toBe("empty");
  });
});
