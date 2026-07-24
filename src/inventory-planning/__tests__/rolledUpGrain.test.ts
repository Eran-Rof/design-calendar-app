import { describe, it, expect } from "vitest";
import { collapseToRolledUpGrain, type RolledUpItem } from "../compute/rolledUpGrain";

// Mirrors the RYB1787 / Black Sands case: one rolled-up (size-NULL) SKU + six
// sized SKUs, all forecast under one customer. Rolled-up wins; sized drop.
function itemMap(entries: Array<[string, RolledUpItem]>) {
  return new Map<string, RolledUpItem>(entries);
}
interface Row { customer_id: string; sku_id: string; period_start: string; qty: number; }
const row = (customer_id: string, sku_id: string, period = "2027-02", qty = 0): Row => ({ customer_id, sku_id, period_start: period, qty });
const qtyOf = (r: Row) => r.qty;

describe("collapseToRolledUpGrain", () => {
  it("drops sized rows when a rolled-up sibling is forecast for the same customer/style/colour", () => {
    // Matches prod: even the bare-code sized SKUs (sku_code "RYB1787-31") carry
    // style_code = "RYB1787", so they group with the rolled-up.
    const items = itemMap([
      ["roll", { style_code: "RYB1787", sku_code: "RYB1787-BLACKSANDS", color: "Black Sands", size: null }],
      ["s30", { style_code: "RYB1787", sku_code: "RYB1787-BLACKSANDS-30", color: "Black Sands", size: "30" }],
      ["s31", { style_code: "RYB1787", sku_code: "RYB1787-31", color: "Black Sands", size: "31" }],
      ["s32", { style_code: "RYB1787", sku_code: "RYB1787-32", color: "Black Sands", size: "32" }],
    ]);
    const rows = [row("ROSS", "roll"), row("ROSS", "s30"), row("ROSS", "s31"), row("ROSS", "s32")];
    const out = collapseToRolledUpGrain(rows, items);
    expect(out.map((r) => r.sku_id)).toEqual(["roll"]);
  });

  it("SAFE fallback: a sized SKU with no style_code (sku_code carries the size) is KEPT, not wrongly dropped", () => {
    const items = itemMap([
      ["roll", { style_code: "RYB1787", color: "Black Sands", size: null }],
      ["orphan", { sku_code: "RYB1787-31", color: "Black Sands", size: "31" }], // no style_code
    ]);
    const out = collapseToRolledUpGrain([row("ROSS", "roll"), row("ROSS", "orphan")], items);
    // Can't prove they're siblings (styleOf falls back to the full sku_code), so
    // keep the row — dropping demand on a guess would be the dangerous error.
    expect(out.map((r) => r.sku_id).sort()).toEqual(["orphan", "roll"]);
  });

  it("size-only group: collapses to ONE representative sized SKU (the replicated family number, not the sum)", () => {
    // RYB1505 GRAYWOLF case: six sizes all 882, no rolled-up. One line = 882.
    const items = itemMap([
      ["s30", { style_code: "RYB1505", color: "Grey Wolf Light Grey", size: "30" }],
      ["s31", { style_code: "RYB1505", color: "Grey Wolf Light Grey", size: "31" }],
      ["s32", { style_code: "RYB1505", color: "Grey Wolf Light Grey", size: "32" }],
    ]);
    const rows = [
      row("ROSS", "s30", "2027-02", 882), row("ROSS", "s31", "2027-02", 882), row("ROSS", "s32", "2027-02", 882),
      row("ROSS", "s30", "2027-03", 882), row("ROSS", "s31", "2027-03", 882), row("ROSS", "s32", "2027-03", 882),
    ];
    const out = collapseToRolledUpGrain(rows, items, qtyOf);
    // One SKU survives, across BOTH periods → one continuous line worth 882/mo.
    const skus = new Set(out.map((r) => r.sku_id));
    expect(skus.size).toBe(1);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.qty === 882)).toBe(true);
  });

  it("size-only, unequal quantities: the greatest-total sized SKU wins", () => {
    const items = itemMap([
      ["s30", { style_code: "RYB1", color: "Indigo", size: "30" }],
      ["s32", { style_code: "RYB1", color: "Indigo", size: "32" }],
    ]);
    const out = collapseToRolledUpGrain(
      [row("ROSS", "s30", "2027-02", 10), row("ROSS", "s32", "2027-02", 40)], items, qtyOf);
    expect(out.map((r) => r.sku_id)).toEqual(["s32"]);
  });

  it("scopes the collapse per customer — one customer's rolled-up doesn't suppress another's sizes", () => {
    const items = itemMap([
      ["roll", { style_code: "RYB1787", color: "Black Sands", size: null }],
      ["s30", { style_code: "RYB1787", color: "Black Sands", size: "30" }],
    ]);
    const rows = [row("ROSS", "roll"), row("SUPPLY", "s30")];
    const out = collapseToRolledUpGrain(rows, items);
    // SUPPLY's sized row survives — ROSS has the rolled-up, SUPPLY does not.
    expect(out.map((r) => `${r.customer_id}:${r.sku_id}`).sort()).toEqual(["ROSS:roll", "SUPPLY:s30"]);
  });

  it("does not collapse across different colours of the same style", () => {
    const items = itemMap([
      ["rollA", { style_code: "RYB1787", color: "Black Sands", size: null }],
      ["s30B", { style_code: "RYB1787", color: "Blue Bleached", size: "30" }],
    ]);
    const rows = [row("ROSS", "rollA"), row("ROSS", "s30B")];
    const out = collapseToRolledUpGrain(rows, items);
    expect(out.map((r) => r.sku_id).sort()).toEqual(["rollA", "s30B"]);
  });

  it("keeps rows for SKUs missing from the item map (can't classify)", () => {
    const items = itemMap([["roll", { style_code: "RYB1787", color: "Black Sands", size: null }]]);
    const rows = [row("ROSS", "roll"), row("ROSS", "unknown")];
    const out = collapseToRolledUpGrain(rows, items);
    expect(out.map((r) => r.sku_id).sort()).toEqual(["roll", "unknown"]);
  });

  it("treats empty-string size as rolled-up, not sized", () => {
    const items = itemMap([
      ["roll", { style_code: "RYB1787", color: "Black Sands", size: "  " }],
      ["s30", { style_code: "RYB1787", color: "Black Sands", size: "30" }],
    ]);
    const out = collapseToRolledUpGrain([row("ROSS", "roll"), row("ROSS", "s30")], items);
    expect(out.map((r) => r.sku_id)).toEqual(["roll"]);
  });

  it("is a no-op when there are no rolled-up rows at all", () => {
    const items = itemMap([["s30", { style_code: "X", color: "Y", size: "30" }]]);
    const rows = [row("ROSS", "s30")];
    expect(collapseToRolledUpGrain(rows, items)).toHaveLength(1);
  });
});
