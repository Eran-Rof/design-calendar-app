import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { enrichRowsWithItemMaster } from "../enrichWithItemMaster";
import { __setCacheForTest, clearItemMasterCache, type ItemMasterRecord } from "../itemMasterLookup";
import type { ATSRow } from "../types";

function makeRow(sku: string, overrides: Partial<ATSRow> = {}): ATSRow {
  return {
    sku,
    description: `desc for ${sku}`,
    store: "ROF",
    onHand: 0,
    onPO: 0,
    onOrder: 0,
    dates: {},
    ...overrides,
  };
}

function makeMasterRec(overrides: Partial<ItemMasterRecord> & { sku_code: string }): ItemMasterRecord {
  return {
    id: `id-${overrides.sku_code}`,
    sku_code: overrides.sku_code,
    style_code: null,
    color: null,
    size: null,
    description: null,
    attributes: null,
    ...overrides,
  };
}

describe("enrichRowsWithItemMaster", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    clearItemMasterCache();
  });

  it("matches all rows by sku and logs at info level", () => {
    __setCacheForTest([
      makeMasterRec({
        sku_code: "ABC123 - Black",
        style_code: "ABC123",
        color: "Black",
        attributes: { group_name: "Tops", category_name: "T-Shirts" },
      }),
      makeMasterRec({
        sku_code: "ABC123 - White",
        style_code: "ABC123",
        color: "White",
        attributes: { group_name: "Tops", category_name: "T-Shirts" },
      }),
      makeMasterRec({
        sku_code: "XYZ789 - Blue",
        style_code: "XYZ789",
        color: "Blue",
        attributes: { group_name: "Bottoms", category_name: "Jeans" },
      }),
    ]);

    const rows: ATSRow[] = [
      makeRow("ABC123 - Black"),
      makeRow("ABC123 - White"),
      makeRow("XYZ789 - Blue"),
    ];

    const { rows: out, summary } = enrichRowsWithItemMaster(rows);

    expect(summary).toEqual({ total: 3, matched: 3, bySku: 3, byStyle: 0, unmatched: 0 });
    expect(out).toHaveLength(3);
    for (const r of out) {
      expect((r as any).master_match_source).toBe("sku");
    }
    expect((out[0] as any).master_category).toBe("Tops");
    expect((out[0] as any).master_sub_category).toBe("T-Shirts");
    expect((out[0] as any).master_style).toBe("ABC123");
    expect((out[0] as any).master_color).toBe("Black");
    expect((out[2] as any).master_category).toBe("Bottoms");
    expect((out[2] as any).master_color).toBe("Blue");

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toContain("coverage 100%");
    expect(infoSpy.mock.calls[0][0]).toContain("3/3 matched");
    expect(infoSpy.mock.calls[0][0]).toContain("3 by sku");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("handles a mix of sku, style, and unmatched rows", () => {
    __setCacheForTest([
      makeMasterRec({
        sku_code: "ABC123 - Black",
        style_code: "ABC123",
        color: "Black",
        attributes: { group_name: "Tops", category_name: "T-Shirts" },
      }),
      makeMasterRec({
        sku_code: "ABC123 - White",
        style_code: "ABC123",
        color: "White",
        attributes: { group_name: "Tops", category_name: "T-Shirts" },
      }),
      // Style-only fallback target — sku_code won't match the test row but
      // style_code will (via the " - " split on the row sku).
      makeMasterRec({
        sku_code: "STY999 - Red",
        style_code: "STY999",
        color: "Red",
        attributes: { group_name: "Outerwear", category_name: "Jackets" },
      }),
    ]);

    const rows: ATSRow[] = [
      makeRow("ABC123 - Black"),                  // sku hit
      makeRow("ABC123 - White"),                  // sku hit
      makeRow("STY999 - SomeNewColorNotInMaster"), // style hit on STY999
      makeRow("NOPE000 - Whatever"),              // miss
    ];

    const { rows: out, summary } = enrichRowsWithItemMaster(rows);

    expect(summary).toEqual({ total: 4, matched: 3, bySku: 2, byStyle: 1, unmatched: 1 });
    expect((out[0] as any).master_match_source).toBe("sku");
    expect((out[1] as any).master_match_source).toBe("sku");
    expect((out[2] as any).master_match_source).toBe("style");
    expect((out[2] as any).master_style).toBe("STY999");
    expect((out[2] as any).master_category).toBe("Outerwear");
    expect((out[3] as any).master_match_source).toBe(null);
    expect((out[3] as any).master_category).toBe(null);
    expect((out[3] as any).master_sub_category).toBe(null);
    expect((out[3] as any).master_style).toBe(null);
    expect((out[3] as any).master_color).toBe(null);

    expect(warnSpy).toHaveBeenCalled();
    const coverageCall = warnSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("coverage"));
    expect(coverageCall?.[0]).toContain("75.0%");
    expect(coverageCall?.[0]).toContain("3/4 matched");
    expect(coverageCall?.[0]).toContain("2 by sku");
    expect(coverageCall?.[0]).toContain("1 by style");
    expect(coverageCall?.[0]).toContain("1 UNMATCHED");

    const listCall = warnSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("unmatched skus"));
    expect(listCall).toBeDefined();
    expect(listCall?.[0]).toContain("unmatched skus (1)");
    expect(listCall?.[0]).toContain("NOPE000 - Whatever");
  });

  it("treats every row as unmatched when the cache is empty", () => {
    __setCacheForTest([]);

    const rows: ATSRow[] = [
      makeRow("ABC123 - Black"),
      makeRow("XYZ789 - Blue"),
    ];

    const { rows: out, summary } = enrichRowsWithItemMaster(rows);

    expect(summary).toEqual({ total: 2, matched: 0, bySku: 0, byStyle: 0, unmatched: 2 });
    for (const r of out) {
      expect((r as any).master_match_source).toBe(null);
      expect((r as any).master_category).toBe(null);
      expect((r as any).master_sub_category).toBe(null);
      expect((r as any).master_style).toBe(null);
      expect((r as any).master_color).toBe(null);
    }

    expect(warnSpy).toHaveBeenCalled();
    const coverageCall = warnSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("coverage"));
    expect(coverageCall?.[0]).toContain("0.0%");
    expect(coverageCall?.[0]).toContain("0/2 matched");
    expect(coverageCall?.[0]).toContain("2 UNMATCHED");
  });

  it("returns empty array and zero summary for empty input", () => {
    __setCacheForTest([
      makeMasterRec({ sku_code: "ABC123 - Black", style_code: "ABC123", color: "Black" }),
    ]);

    const { rows: out, summary } = enrichRowsWithItemMaster([]);

    expect(out).toEqual([]);
    expect(summary).toEqual({ total: 0, matched: 0, bySku: 0, byStyle: 0, unmatched: 0 });

    expect(infoSpy).toHaveBeenCalledWith("[ats master] no rows to enrich");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not mutate input rows", () => {
    __setCacheForTest([
      makeMasterRec({
        sku_code: "ABC123 - Black",
        style_code: "ABC123",
        color: "Black",
        attributes: { group_name: "Tops", category_name: "T-Shirts" },
      }),
    ]);

    const inputRows: ATSRow[] = [
      makeRow("ABC123 - Black", { onHand: 50 }),
      makeRow("NOPE - Nothing"),
    ];
    // Snapshot deep copies for later equality comparison.
    const snapshot = JSON.parse(JSON.stringify(inputRows));

    const { rows: out } = enrichRowsWithItemMaster(inputRows);

    // Original references must still exist and be unchanged.
    expect(inputRows).toEqual(snapshot);
    // No master_* fields leaked onto inputs.
    expect((inputRows[0] as any).master_category).toBeUndefined();
    expect((inputRows[0] as any).master_match_source).toBeUndefined();
    // Result objects are distinct.
    expect(out[0]).not.toBe(inputRows[0]);
    expect(out[1]).not.toBe(inputRows[1]);
  });

  it("uses warn level for partial coverage and always logs the full unmatched list (phase 1 diagnostic)", () => {
    __setCacheForTest([
      makeMasterRec({ sku_code: "HIT - Black", style_code: "HIT", color: "Black" }),
    ]);

    const rows: ATSRow[] = [makeRow("HIT - Black")];
    for (let i = 0; i < 11; i++) {
      rows.push(makeRow(`MISS${i} - X`));
    }

    enrichRowsWithItemMaster(rows);

    expect(warnSpy).toHaveBeenCalled();
    const coverageCall = warnSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("coverage"));
    expect(coverageCall).toBeDefined();
    const listCall = warnSpy.mock.calls.find(c => typeof c[0] === "string" && c[0].includes("unmatched skus"));
    expect(listCall).toBeDefined();
    const listText = listCall![0] as string;
    expect(listText).toContain("unmatched skus (11)");
    for (let i = 0; i < 11; i++) {
      expect(listText).toContain(`MISS${i} - X`);
    }
  });
});
