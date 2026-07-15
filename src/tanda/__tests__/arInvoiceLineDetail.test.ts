import { describe, it, expect } from "vitest";
import { buildArLineDetail, type ArDetailItem, type ArDetailLineInput } from "../arInvoiceLineDetail";

function item(over: Partial<ArDetailItem> & { id: string }): ArDetailItem {
  return { ...over };
}

describe("buildArLineDetail", () => {
  it("groups sized apparel lines into a per-style color × size matrix", () => {
    const items = new Map<string, ArDetailItem>([
      ["i1", item({ id: "i1", style_code: "RYB0412", color: "Black", size: "S", sku_code: "RYB0412-BLK-S" })],
      ["i2", item({ id: "i2", style_code: "RYB0412", color: "Black", size: "M", sku_code: "RYB0412-BLK-M" })],
      ["i3", item({ id: "i3", style_code: "RYB0412", color: "Navy", size: "S", sku_code: "RYB0412-NVY-S" })],
    ]);
    const lines: ArDetailLineInput[] = [
      { inventory_item_id: "i1", quantity: 3, unit_price_cents: "700", line_total_cents: "2100", description: null },
      { inventory_item_id: "i2", quantity: 2, unit_price_cents: "700", line_total_cents: "1400", description: null },
      { inventory_item_id: "i3", quantity: 5, unit_price_cents: "800", line_total_cents: "4000", description: null },
    ];
    const { styles, flat } = buildArLineDetail(lines, items);
    expect(flat).toHaveLength(0);
    expect(styles).toHaveLength(1);
    const st = styles[0];
    expect(st.styleCode).toBe("RYB0412");
    // Sizes canonicalized (S→SMALL, M→MEDIUM) and ordered by scale.
    expect(st.sizes).toEqual(["SMALL", "MEDIUM"]);
    expect(st.colors.get("Black")!.get("SMALL")).toEqual({ qty: 3, extCents: 2100 });
    expect(st.colors.get("Black")!.get("MEDIUM")).toEqual({ qty: 2, extCents: 1400 });
    expect(st.colors.get("Navy")!.get("SMALL")).toEqual({ qty: 5, extCents: 4000 });
  });

  it("accumulates duplicate style/color/size lines into one cell", () => {
    const items = new Map<string, ArDetailItem>([
      ["i1", item({ id: "i1", style_code: "S1", color: "Red", size: "L" })],
    ]);
    const lines: ArDetailLineInput[] = [
      { inventory_item_id: "i1", quantity: 2, unit_price_cents: "500", line_total_cents: "1000", description: null },
      { inventory_item_id: "i1", quantity: 4, unit_price_cents: "500", line_total_cents: "2000", description: null },
    ];
    const { styles } = buildArLineDetail(lines, items);
    expect(styles[0].colors.get("Red")!.get("LARGE")).toEqual({ qty: 6, extCents: 3000 });
  });

  it("routes amount-only and unresolved lines to the flat list", () => {
    const items = new Map<string, ArDetailItem>([
      // resolved but no size → not matrixable
      ["i1", item({ id: "i1", style_code: "S1", color: "Red", size: null, sku_code: "S1-RED" })],
    ]);
    const lines: ArDetailLineInput[] = [
      { inventory_item_id: null, quantity: null, unit_price_cents: null, line_total_cents: "5000", description: "Freight" },
      { inventory_item_id: "i1", quantity: 1, unit_price_cents: "900", line_total_cents: "900", description: null },
    ];
    const { styles, flat } = buildArLineDetail(lines, items);
    expect(styles).toHaveLength(0);
    expect(flat).toHaveLength(2);
    expect(flat[0]).toEqual({ label: "Freight", qty: null, unitCents: null, extCents: 5000 });
    // unresolved-to-size line falls back to sku label + computed ext from qty*unit
    expect(flat[1]).toEqual({ label: "S1-RED", qty: 1, unitCents: 900, extCents: 900 });
  });
});
