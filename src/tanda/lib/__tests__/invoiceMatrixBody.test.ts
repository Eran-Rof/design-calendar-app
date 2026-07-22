import { describe, it, expect } from "vitest";
import {
  buildInvoiceMatrixBody,
  type InvoiceMatrixItem,
  type InvoiceMatrixLineInput,
} from "../invoiceMatrixBody";

function items(list: (InvoiceMatrixItem & { id: string })[]): Map<string, InvoiceMatrixItem> {
  return new Map(list.map((it) => [it.id, it]));
}

describe("buildInvoiceMatrixBody", () => {
  it("groups sized lines into a per-style color × size matrix carrying the style code + name", () => {
    const m = items([
      { id: "i1", style_code: "RYB0412", color: "Black", size: "S", sku_code: "RYB0412-BLK-S", description: "Rylan Tee" },
      { id: "i2", style_code: "RYB0412", color: "Black", size: "M", sku_code: "RYB0412-BLK-M", description: "Rylan Tee" },
      { id: "i3", style_code: "RYB0412", color: "Navy", size: "S", sku_code: "RYB0412-NVY-S", description: "Rylan Tee" },
    ]);
    const lines: InvoiceMatrixLineInput[] = [
      { inventory_item_id: "i1", quantity: 3, unitCents: 700, description: "Rylan Tee" },
      { inventory_item_id: "i2", quantity: 2, unitCents: 700, description: "Rylan Tee" },
      { inventory_item_id: "i3", quantity: 5, unitCents: 800, description: "Rylan Tee" },
    ];
    const { styles, flat } = buildInvoiceMatrixBody(lines, m);
    expect(flat).toHaveLength(0);
    expect(styles).toHaveLength(1);
    const st = styles[0];
    expect(st.styleCode).toBe("RYB0412");
    expect(st.styleName).toBe("Rylan Tee");
    expect(st.inseam).toBeNull();
    // Sizes canonicalized (S→SMALL, M→MEDIUM) and ordered by scale.
    expect(st.sizes).toEqual(["SMALL", "MEDIUM"]);
    expect(st.colors.get("Black")!.get("SMALL")).toEqual({ qty: 3, extCents: 2100 });
    expect(st.colors.get("Black")!.get("MEDIUM")).toEqual({ qty: 2, extCents: 1400 });
    expect(st.colors.get("Navy")!.get("SMALL")).toEqual({ qty: 5, extCents: 4000 });
  });

  it("merges CASE-variant colorways into one row (BLACK vs Black)", () => {
    const m = items([
      { id: "a", style_code: "S1", color: "BLACK", size: "S" },
      { id: "b", style_code: "S1", color: "Black", size: "M" },
    ]);
    const lines: InvoiceMatrixLineInput[] = [
      { inventory_item_id: "a", quantity: 1, unitCents: 500 },
      { inventory_item_id: "b", quantity: 2, unitCents: 500 },
    ];
    const { styles } = buildInvoiceMatrixBody(lines, m);
    const colors = [...styles[0].colors.keys()];
    expect(colors).toEqual(["Black"]); // one merged, title-cased row
    expect(styles[0].colors.get("Black")!.get("SMALL")).toEqual({ qty: 1, extCents: 500 });
    expect(styles[0].colors.get("Black")!.get("MEDIUM")).toEqual({ qty: 2, extCents: 1000 });
  });

  it("accumulates duplicate style/color/size lines into one cell", () => {
    const m = items([{ id: "i1", style_code: "S1", color: "Red", size: "L" }]);
    const lines: InvoiceMatrixLineInput[] = [
      { inventory_item_id: "i1", quantity: 2, unitCents: 500 },
      { inventory_item_id: "i1", quantity: 4, unitCents: 500 },
    ];
    const { styles } = buildInvoiceMatrixBody(lines, m);
    expect(styles[0].colors.get("Red")!.get("LARGE")).toEqual({ qty: 6, extCents: 3000 });
  });

  it("routes amount-only, expense, and null-size lines to the flat list", () => {
    const m = items([
      { id: "i1", style_code: "S1", color: "Red", size: null, sku_code: "S1-RED" }, // resolved but no size
    ]);
    const lines: InvoiceMatrixLineInput[] = [
      { inventory_item_id: null, quantity: null, unitCents: null, lineTotalCents: 5000, description: "Freight" },
      { inventory_item_id: "i1", quantity: 1, unitCents: 900, lineTotalCents: 900, description: null },
    ];
    const { styles, flat } = buildInvoiceMatrixBody(lines, m);
    expect(styles).toHaveLength(0);
    expect(flat).toHaveLength(2);
    expect(flat[0]).toEqual({ label: "Freight", qty: null, unitCents: null, extCents: 5000 });
    // null-size line falls back to the sku label + qty*unit ext (no crash, qty kept)
    expect(flat[1]).toEqual({ label: "S1-RED", qty: 1, unitCents: 900, extCents: 900 });
  });

  it("shows a uniform inseam once in the style header (jeans)", () => {
    const m = items([
      { id: "a", style_code: "DNM1", color: "Indigo", size: "30", inseam: "32" },
      { id: "b", style_code: "DNM1", color: "Indigo", size: "32", inseam: "32" },
    ]);
    const lines: InvoiceMatrixLineInput[] = [
      { inventory_item_id: "a", quantity: 1, unitCents: 4000 },
      { inventory_item_id: "b", quantity: 1, unitCents: 4000 },
    ];
    const { styles } = buildInvoiceMatrixBody(lines, m);
    expect(styles[0].inseam).toBe("32");
    expect([...styles[0].colors.keys()]).toEqual(["Indigo"]); // no inseam suffix on the row
  });

  it("appends a MIXED inseam to the colorway label and keeps the header inseam null", () => {
    const m = items([
      { id: "a", style_code: "DNM1", color: "Indigo", size: "30", inseam: "30" },
      { id: "b", style_code: "DNM1", color: "Indigo", size: "30", inseam: "32" },
    ]);
    const lines: InvoiceMatrixLineInput[] = [
      { inventory_item_id: "a", quantity: 1, unitCents: 4000 },
      { inventory_item_id: "b", quantity: 2, unitCents: 4000 },
    ];
    const { styles } = buildInvoiceMatrixBody(lines, m);
    expect(styles[0].inseam).toBeNull();
    const colors = [...styles[0].colors.keys()].sort();
    expect(colors).toEqual(['Indigo · 30"', 'Indigo · 32"']);
  });

  it("collects distinct PO numbers per style (AP bill lines)", () => {
    const m = items([
      { id: "a", style_code: "S1", color: "Red", size: "S" },
      { id: "b", style_code: "S1", color: "Red", size: "M" },
    ]);
    const lines: InvoiceMatrixLineInput[] = [
      { inventory_item_id: "a", quantity: 1, unitCents: 100, poNumber: "ROF-P000080" },
      { inventory_item_id: "b", quantity: 1, unitCents: 100, poNumber: "ROF-P000080" },
    ];
    const { styles } = buildInvoiceMatrixBody(lines, m);
    expect(styles[0].poNumbers).toEqual(["ROF-P000080"]);
  });

  it("treats a PPK pack token as its own size column (no explosion)", () => {
    const m = items([
      { id: "a", style_code: "RYB0594PPK", color: "Black", size: "PPK18" },
    ]);
    const lines: InvoiceMatrixLineInput[] = [
      { inventory_item_id: "a", quantity: 4, unitCents: 12000 },
    ];
    const { styles } = buildInvoiceMatrixBody(lines, m);
    expect(styles[0].sizes).toEqual(["PPK18"]);
    expect(styles[0].colors.get("Black")!.get("PPK18")).toEqual({ qty: 4, extCents: 48000 });
  });
});
