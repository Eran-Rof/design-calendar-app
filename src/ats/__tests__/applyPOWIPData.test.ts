import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { applyPOWIPDataToExcel } from "../hooks/usePOWIPSync";
import type { ExcelData } from "../types";

// Minimal in-memory stub for the Supabase tanda_pos fetch.
function stubTandaPos(rows: any[]) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => rows,
  }) as any) as any;
}

function makeData(overrides: Partial<ExcelData> = {}): ExcelData {
  return {
    syncedAt: "2026-04-01T00:00:00Z",
    skus: [],
    pos: [],
    sos: [],
    ...overrides,
  };
}

const origFetch = global.fetch;
afterEach(() => { global.fetch = origFetch; });

describe("applyPOWIPDataToExcel", () => {
  it("returns input unchanged when fetch fails", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => [] }) as any) as any;
    const data = makeData({ skus: [{ sku: "A", description: "", store: "ROF", onHand: 5, onOrder: 0 }] });
    const out = await applyPOWIPDataToExcel(data);
    expect(out).toBe(data);
  });

  it("does not mutate input — returns a fresh object with fresh arrays", async () => {
    stubTandaPos([{
      data: {
        PoNumber: "PO1",
        VendorName: "Acme",
        DateExpectedDelivery: "2026-05-01",
        BrandName: "ROF",
        Items: [{ ItemNumber: "NEW-SKU", QtyRemaining: 10, UnitPrice: 4 }],
      },
    }]);

    const input = makeData({
      skus: [{ sku: "EXISTING", description: "", store: "ROF", onHand: 5, onOrder: 2 }],
    });
    const originalSkusRef = input.skus;
    const originalSkuRef  = input.skus[0];
    const originalPosRef  = input.pos;

    const out = await applyPOWIPDataToExcel(input);

    expect(out).not.toBe(input);                     // fresh top-level
    expect(out.skus).not.toBe(originalSkusRef);      // fresh array
    expect(out.pos).not.toBe(originalPosRef);        // fresh array
    expect(out.skus[0]).not.toBe(originalSkuRef);    // entries are fresh copies (pure)
    expect(out.skus[0]).toEqual(originalSkuRef);     // same data, different reference
    expect(input.skus).toHaveLength(1);              // input unchanged
    expect(input.pos).toHaveLength(0);               // input unchanged
    expect(out.skus).toHaveLength(2);                // new sku added
    expect(out.pos).toHaveLength(1);
  });

  it("sums onOrder when the sku already exists", async () => {
    // xoroSkuToExcel splits "BASE-COLOR" → "BASE - COLOR", then normalizeSku
    // title-cases → "Base - Color". Input sku must use the normalized form
    // to match (since baked excelData is normalized on upload).
    stubTandaPos([{
      data: {
        PoNumber: "PO1",
        VendorName: "V",
        DateExpectedDelivery: "2026-05-01",
        BrandName: "ROF",
        Items: [{ ItemNumber: "BASE-COLOR", QtyRemaining: 7, UnitPrice: 3 }],
      },
    }]);

    const input = makeData({
      skus: [{ sku: "BASE - Color", description: "", store: "ROF", onHand: 0, onOrder: 10 }],
    });
    const out = await applyPOWIPDataToExcel(input);

    expect(out.skus).toHaveLength(1);
    expect(out.skus[0].onOrder).toBe(17);
    // Input entry unchanged
    expect(input.skus[0].onOrder).toBe(10);
  });

  it("skips archived POs and zero-qty items", async () => {
    stubTandaPos([
      { data: { _archived: true,  PoNumber: "PO1", Items: [{ ItemNumber: "X", QtyRemaining: 5 }] } },
      { data: { PoNumber: "PO2", Items: [{ ItemNumber: "Y", QtyRemaining: 0 }] } },
    ]);
    const out = await applyPOWIPDataToExcel(makeData());
    expect(out.skus).toHaveLength(0);
    expect(out.pos).toHaveLength(0);
  });

  it("infers store from PO number and brand name", async () => {
    stubTandaPos([
      { data: { PoNumber: "ECOM-001", BrandName: "ROF", Items: [{ ItemNumber: "E", QtyRemaining: 1 }], DateExpectedDelivery: "2026-05-01" } },
      { data: { PoNumber: "PO-999",   BrandName: "PSYCHO TUNA", Items: [{ ItemNumber: "P", QtyRemaining: 1 }], DateExpectedDelivery: "2026-05-01" } },
      { data: { PoNumber: "PO-111",   BrandName: "Ring of Fire", Items: [{ ItemNumber: "R", QtyRemaining: 1 }], DateExpectedDelivery: "2026-05-01" } },
    ]);
    const out = await applyPOWIPDataToExcel(makeData());
    const bySku = Object.fromEntries(out.skus.map(s => [s.sku, s.store]));
    expect(bySku["E"]).toBe("ROF ECOM");
    expect(bySku["P"]).toBe("PT");
    expect(bySku["R"]).toBe("ROF");
  });
});
