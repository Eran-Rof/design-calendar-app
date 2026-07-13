import { describe, it, expect } from "vitest";
import { cmpMulti } from "../panels/wholesale-planning/gridUtils";
import type { IpPlanningGridRow } from "../types/wholesale";
import type { SortEntry } from "../panels/wholesale-planning/types";

// Minimal rows — cmpMulti only reads the fields the sort keys touch.
const row = (customer: string, period: string, buy: number): IpPlanningGridRow =>
  ({ customer_name: customer, period_start: period, planned_buy_qty: buy } as unknown as IpPlanningGridRow);

describe("cmpMulti — multi-column sort (parent → child)", () => {
  it("sorts by the parent key first, child key as tie-breaker", () => {
    const stack: SortEntry[] = [{ key: "customer", dir: "asc" }, { key: "period", dir: "asc" }];
    const rows = [
      row("Ross", "2026-08-01", 5),
      row("Amazon", "2026-06-01", 9),
      row("Ross", "2026-06-01", 1),
    ];
    rows.sort((a, b) => cmpMulti(a, b, stack));
    expect(rows.map((r) => `${r.customer_name}/${r.period_start}`)).toEqual([
      "Amazon/2026-06-01",   // parent (customer) first
      "Ross/2026-06-01",     // then Ross, earliest period first (child)
      "Ross/2026-08-01",
    ]);
  });

  it("honors each level's own direction independently", () => {
    // Customer ascending, but Period DESCENDING within each customer.
    const stack: SortEntry[] = [{ key: "customer", dir: "asc" }, { key: "period", dir: "desc" }];
    const rows = [
      row("Ross", "2026-06-01", 1),
      row("Ross", "2026-08-01", 5),
    ];
    rows.sort((a, b) => cmpMulti(a, b, stack));
    expect(rows.map((r) => r.period_start)).toEqual(["2026-08-01", "2026-06-01"]);
  });

  it("a single-entry stack behaves like a plain single-column sort", () => {
    const stack: SortEntry[] = [{ key: "customer", dir: "desc" }];
    const rows = [row("Amazon", "x", 0), row("Ross", "x", 0)];
    rows.sort((a, b) => cmpMulti(a, b, stack));
    expect(rows.map((r) => r.customer_name)).toEqual(["Ross", "Amazon"]);
  });

  it("empty stack preserves input order (returns 0)", () => {
    expect(cmpMulti(row("Ross", "x", 0), row("Amazon", "y", 0), [])).toBe(0);
  });
});
