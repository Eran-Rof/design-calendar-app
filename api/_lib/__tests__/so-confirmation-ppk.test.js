// SO confirmation — PPK breakdown (inner pack + carton pack composition + full
// garment explode). Verifies the HTML the email confirmation embeds for prepack
// styles (operator request: show pack matrix + full explode on the confirmation).

import { describe, it, expect } from "vitest";
import { isPpkLine, prepackBreakdownHtml } from "../../_handlers/internal/sales-orders/email-confirmation.js";

describe("isPpkLine", () => {
  it("detects a PPK style line", () => {
    expect(isPpkLine({ style_code: "RYB0412PPK" })).toBe(true);
    expect(isPpkLine({ sku_code: "ryb059430ppk-blk" })).toBe(true);
  });
  it("is false for a normal sized line", () => {
    expect(isPpkLine({ style_code: "RYB0412", size: "MEDIUM" })).toBe(false);
  });
});

describe("prepackBreakdownHtml", () => {
  // One pack of RYB0412PPK = 6+6+6+6 = 24 garments (carton pack); inner pack 1 each.
  const matrices = [{
    ppk_style_code: "RYB0412PPK", pack_token: "PPK24", pack_total: 24, name: "RYB0412 prepack",
    sizes: [
      { size: "SML", qty_per_pack: 6, inner_pack_qty: 1, sort_order: 0 },
      { size: "MED", qty_per_pack: 6, inner_pack_qty: 1, sort_order: 1 },
      { size: "LRG", qty_per_pack: 6, inner_pack_qty: 1, sort_order: 2 },
      { size: "XLG", qty_per_pack: 6, inner_pack_qty: 1, sort_order: 3 },
    ],
  }];
  const lines = [
    { style_code: "RYB0412PPK", color: "BLACK", size: "PPK24", qty_ordered: 10 },
    { style_code: "RYB0412PPK", color: "WHITE", size: "PPK24", qty_ordered: 5 },
  ];

  it("returns empty when there are no PPK lines", () => {
    expect(prepackBreakdownHtml([{ style_code: "RYB0412", size: "MED", qty_ordered: 3 }], matrices)).toBe("");
  });

  it("renders inner pack + carton pack rows and the full explode totals", () => {
    const html = prepackBreakdownHtml(lines, matrices);
    expect(html).toContain("Inner pack");
    expect(html).toContain("Carton pack");
    expect(html).toContain("Prepack breakdown");
    // Carton pack total per pack = 24.
    expect(html).toContain(">24<");
    // BLACK explode: 10 packs × 6/size = 60 per size; total 240.
    expect(html).toContain(">60<");
    expect(html).toContain(">240<");
    // WHITE explode: 5 × 6 = 30 per size; total 120.
    expect(html).toContain(">30<");
    expect(html).toContain(">120<");
    // Grand totals across colors: units 240+120 = 360; packs 15.
    expect(html).toContain(">360<");
    expect(html).toContain(">15<");
  });

  it("notes a missing matrix instead of throwing", () => {
    const html = prepackBreakdownHtml([{ style_code: "ZZZPPK", color: "RED", size: "PPK12", qty_ordered: 2 }], matrices);
    expect(html).toContain("no size breakdown is defined");
  });
});
