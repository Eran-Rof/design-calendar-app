import { describe, it, expect } from "vitest";
import { buildCreditMemoLines } from "../sales-returns/creditMemo.js";

const RETURNS = "4100-acct";

function line(over = {}) {
  return { id: "l1", line_number: 1, disposition: "scrap", qty_returned: 2, unit_price_cents: 1000, ...over };
}

describe("buildCreditMemoLines", () => {
  it("scrap line → revenue-only credit (no inventory fields), routed to 4100", () => {
    const lines = buildCreditMemoLines({ rmaLines: [line()], returnsAccountId: RETURNS, costByItem: new Map() });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      revenue_account_id: RETURNS, unit_price_cents: 1000, line_total_cents: "2000",
    });
    expect(lines[0].inventory_item_id).toBeUndefined();
    expect(lines[0].quantity).toBeUndefined();
  });

  it("routes the revenue reversal to the per-style returns account when provided, else 4100 (#6)", () => {
    const lines = buildCreditMemoLines({
      rmaLines: [
        line({ id: "a", line_number: 1, inventory_item_id: "i-rof" }),  // has a style returns acct
        line({ id: "b", line_number: 2, inventory_item_id: "i-none" }), // no entry → fallback
        line({ id: "c", line_number: 3 }),                              // no item → fallback
      ],
      returnsAccountId: RETURNS,
      costByItem: new Map(),
      returnsByItem: new Map([["i-rof", "4236-rof-returns"]]),
    });
    expect(lines.map((l) => l.revenue_account_id)).toEqual(["4236-rof-returns", RETURNS, RETURNS]);
  });

  it("restock line → carries inventory_item_id, quantity, resolved cost", () => {
    const rl = line({ disposition: "restock", inventory_item_id: "item-9", qty_returned: 3, unit_price_cents: 1500 });
    const lines = buildCreditMemoLines({ rmaLines: [rl], returnsAccountId: RETURNS, costByItem: new Map([["item-9", 480]]) });
    expect(lines[0]).toMatchObject({
      inventory_item_id: "item-9", quantity: 3, return_unit_cost_cents: 480, line_total_cents: "4500",
    });
  });

  it("restock without an item is treated as a plain credit (revenue-only)", () => {
    const rl = line({ disposition: "restock", inventory_item_id: null });
    const lines = buildCreditMemoLines({ rmaLines: [rl], returnsAccountId: RETURNS, costByItem: new Map() });
    expect(lines[0].inventory_item_id).toBeUndefined();
  });

  it("throws if a restock line has no resolved cost", () => {
    const rl = line({ disposition: "restock", inventory_item_id: "item-x" });
    expect(() => buildCreditMemoLines({ rmaLines: [rl], returnsAccountId: RETURNS, costByItem: new Map() }))
      .toThrow(/no inventory cost resolved/);
  });

  it("throws on a pending disposition", () => {
    expect(() => buildCreditMemoLines({ rmaLines: [line({ disposition: "pending" })], returnsAccountId: RETURNS, costByItem: new Map() }))
      .toThrow(/disposition not set/);
  });

  it("skips zero-qty lines and throws if nothing creditable remains", () => {
    expect(() => buildCreditMemoLines({ rmaLines: [line({ qty_returned: 0 })], returnsAccountId: RETURNS, costByItem: new Map() }))
      .toThrow(/no creditable return lines/);
  });

  it("indexes line_index sequentially across mixed dispositions", () => {
    const lines = buildCreditMemoLines({
      rmaLines: [
        line({ id: "a", line_number: 1, disposition: "scrap" }),
        line({ id: "b", line_number: 2, disposition: "restock", inventory_item_id: "i2" }),
      ],
      returnsAccountId: RETURNS, costByItem: new Map([["i2", 100]]),
    });
    expect(lines.map((l) => l.line_index)).toEqual([1, 2]);
  });
});
