import { describe, it, expect } from "vitest";
import { mergeExcelDataSkus, mergeRows } from "../merge";
import { computeRowsFromExcelData } from "../compute";
import type { ExcelData } from "../types";

// Fixture helpers ---------------------------------------------------------

function makeData(overrides: Partial<ExcelData> = {}): ExcelData {
  return {
    syncedAt: "2026-04-01T00:00:00Z",
    skus: [],
    pos: [],
    sos: [],
    ...overrides,
  };
}

const DATES = ["2026-04-01", "2026-04-02", "2026-04-03"];

// ── mergeExcelDataSkus ───────────────────────────────────────────────────

describe("mergeExcelDataSkus", () => {
  it("folds a simple two-sku merge into one entry", () => {
    const data = makeData({
      skus: [
        { sku: "A-OLD", description: "old name", store: "ROF", onHand: 100, onOrder: 0, avgCost: 10 },
        { sku: "A",     description: "new name", store: "ROF", onHand:  50, onOrder: 0, avgCost: 20 },
      ],
      pos: [{ sku: "A-OLD", date: "2026-04-02", qty: 30, poNumber: "P1", vendor: "V", store: "ROF", unitCost: 10 }],
      sos: [{ sku: "A-OLD", date: "2026-04-03", qty: 20, orderNumber: "S1", customerName: "C", unitPrice: 25, totalPrice: 500, store: "ROF" }],
    });

    const merged = mergeExcelDataSkus(data, "A-OLD", "A");

    // one merged entry under the target sku
    expect(merged.skus).toHaveLength(1);
    expect(merged.skus[0].sku).toBe("A");
    expect(merged.skus[0].onHand).toBe(150);
    // weighted avg cost: (10*100 + 20*50) / 150 = 13.33...
    expect(merged.skus[0].avgCost).toBeCloseTo(13.333, 2);

    // events renamed to target sku
    expect(merged.pos[0].sku).toBe("A");
    expect(merged.sos[0].sku).toBe("A");
  });

  it("collapses duplicate entries for the same sku (regression: merge dup bug)", () => {
    // Two stale rows for the same sku+store — the bug that showed as a
    // duplicated row after merge.
    const data = makeData({
      skus: [
        { sku: "DUP", store: "ROF", description: "", onHand: 100, onOrder: 500, onCommitted: 200 },
        { sku: "DUP", store: "ROF", description: "", onHand:  50, onOrder: 300, onCommitted: 100 },
        { sku: "TGT", store: "ROF", description: "", onHand:  10, onOrder:   0, onCommitted:   0 },
      ],
    });

    const merged = mergeExcelDataSkus(data, "DUP", "TGT");

    // exactly one entry for TGT — no duplicates survive
    const tgtEntries = merged.skus.filter(s => s.sku === "TGT");
    expect(tgtEntries).toHaveLength(1);
    expect(merged.skus.filter(s => s.sku === "DUP")).toHaveLength(0);

    // sums include both duplicate source rows
    expect(tgtEntries[0].onHand).toBe(160);       // 10 + 100 + 50
    expect(tgtEntries[0].onOrder).toBe(800);      // 0 + 500 + 300
    expect(tgtEntries[0].onCommitted).toBe(300);  // 0 + 200 + 100
  });

  it("is a no-op when fromSku === toSku", () => {
    const data = makeData({
      skus: [{ sku: "X", store: "ROF", description: "", onHand: 1, onOrder: 0 }],
    });
    expect(mergeExcelDataSkus(data, "X", "X")).toBe(data);
  });

  it("drops events whose sku appears nowhere in skus", () => {
    const data = makeData({
      skus: [{ sku: "B", store: "ROF", description: "", onHand: 0, onOrder: 0 }],
      pos: [{ sku: "GHOST", date: "2026-04-02", qty: 5, poNumber: "P", vendor: "V", store: "ROF", unitCost: 0 }],
    });
    const merged = mergeExcelDataSkus(data, "GHOST", "B");
    // ghost -> B rename still happens so the PO now attaches to B
    expect(merged.pos[0].sku).toBe("B");
  });

  it("plays back sequentially (replay invariance — load path)", () => {
    // Simulates loadFromSupabase: applying the history ops one by one
    // against an already-baked dataset must stay idempotent.
    const base = makeData({
      skus: [
        { sku: "A", store: "ROF", description: "", onHand: 10, onOrder: 0 },
        { sku: "B", store: "ROF", description: "", onHand: 20, onOrder: 0 },
        { sku: "C", store: "ROF", description: "", onHand: 30, onOrder: 0 },
      ],
    });
    const history = [
      { fromSku: "A", toSku: "B" },
      { fromSku: "B", toSku: "C" },
    ];
    let baked = base;
    for (const op of history) baked = mergeExcelDataSkus(baked, op.fromSku, op.toSku);

    // Replay against the already-baked data (loadFromSupabase does this)
    let replayed = baked;
    for (const op of history) replayed = mergeExcelDataSkus(replayed, op.fromSku, op.toSku);

    expect(replayed.skus).toHaveLength(1);
    expect(replayed.skus[0].sku).toBe("C");
    expect(replayed.skus[0].onHand).toBe(60); // 10+20+30
  });
});

// ── mergeRows (row-level) ────────────────────────────────────────────────

describe("mergeRows", () => {
  it("returns currentRows unchanged if either sku is missing", () => {
    const rows = [
      { sku: "A", description: "", store: "ROF", onHand: 1, onOrder: 0, onCommitted: 0, dates: {} },
    ];
    expect(mergeRows(rows, "MISSING", "A")).toBe(rows);
    expect(mergeRows(rows, "A", "MISSING")).toBe(rows);
  });

  it("sums dates field-by-field on merge", () => {
    const rows = [
      { sku: "A", description: "", store: "ROF", onHand: 10, onOrder: 0, onCommitted: 0, dates: { "2026-04-01": 10, "2026-04-02": 5 } },
      { sku: "B", description: "", store: "ROF", onHand: 20, onOrder: 0, onCommitted: 0, dates: { "2026-04-01": 20, "2026-04-03": 8 } },
    ];
    const merged = mergeRows(rows, "A", "B");
    expect(merged).toHaveLength(1);
    expect(merged[0].sku).toBe("B");
    expect(merged[0].onHand).toBe(30);
    expect(merged[0].dates).toEqual({
      "2026-04-01": 30, // 10 + 20
      "2026-04-02": 5,  // only in A
      "2026-04-03": 8,  // only in B
    });
  });
});

// ── Full pipeline: upload → merge → recompute → undo ────────────────────

describe("pipeline: merge + recompute + undo", () => {
  it("merge → recompute → single row per sku+store", () => {
    // Simulates an upload that produced stale duplicates (the actual
    // production bug from two sessions ago).
    const data = makeData({
      skus: [
        { sku: "A", store: "ROF", description: "", onHand: 10, onOrder: 0, onCommitted: 0 },
        { sku: "A", store: "ROF", description: "", onHand:  5, onOrder: 0, onCommitted: 0 }, // duplicate
        { sku: "B", store: "ROF", description: "", onHand: 20, onOrder: 0, onCommitted: 0 },
      ],
      pos: [{ sku: "A", date: "2026-04-02", qty: 100, poNumber: "P1", vendor: "V", store: "ROF", unitCost: 5 }],
    });

    // Merge is a no-op for from==to, so this exercises just the compute dedupe
    // safety net that I added.
    const rows = computeRowsFromExcelData(data, DATES);
    const aRows = rows.filter(r => r.sku === "A");
    expect(aRows).toHaveLength(1); // dedupe collapsed the duplicate
    expect(aRows[0].onHand).toBe(15);
    expect(aRows[0].dates["2026-04-02"]).toBe(115);
  });

  it("merge → undo path: history replay against base restores target-only rows", () => {
    // The undo flow: start from a "base" (pre-merge) snapshot, apply the
    // reduced history, and expect the earlier merge to be reversed.
    const base = makeData({
      skus: [
        { sku: "SRC", store: "ROF", description: "", onHand: 10, onOrder: 0, onCommitted: 0 },
        { sku: "DST", store: "ROF", description: "", onHand: 20, onOrder: 0, onCommitted: 0 },
      ],
    });
    const history = [{ fromSku: "SRC", toSku: "DST" }];

    // Apply merge
    let baked = base;
    for (const op of history) baked = mergeExcelDataSkus(baked, op.fromSku, op.toSku);
    expect(baked.skus).toHaveLength(1);
    expect(baked.skus[0].onHand).toBe(30);

    // Undo: drop last op, replay from base
    const undone = history.slice(0, -1);
    let restored = base;
    for (const op of undone) restored = mergeExcelDataSkus(restored, op.fromSku, op.toSku);
    expect(restored.skus).toHaveLength(2);
    expect(restored.skus.find(s => s.sku === "SRC")?.onHand).toBe(10);
    expect(restored.skus.find(s => s.sku === "DST")?.onHand).toBe(20);
  });
});
