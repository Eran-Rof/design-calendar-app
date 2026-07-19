import { describe, it, expect } from "vitest";
import { isTransientDbError, avgCostRowsToMap } from "../services/wholesalePlanningRepository";

// Guards the 2026-07-19 all-costs-blank incident: a transient Supabase
// error on the ip_item_avg_cost load must be classified as retryable, and
// the row→map reduction must drop junk without nuking valid rows.

describe("isTransientDbError", () => {
  it("classifies statement timeouts (57014) as transient", () => {
    expect(isTransientDbError(new Error("canceling statement due to statement timeout (57014)"))).toBe(true);
  });
  it("classifies bare 5xx / gateway / connection blips as transient", () => {
    for (const m of [
      "Supabase GET failed: 500 Internal Server Error",
      "Supabase GET failed: 502 Bad Gateway",
      "Supabase GET failed: 503 Service Unavailable",
      "Supabase GET failed: 504 Gateway Timeout",
      "TypeError: fetch failed",
      "read ECONNRESET",
      "network request timeout",
    ]) {
      expect(isTransientDbError(new Error(m)), m).toBe(true);
    }
  });
  it("does NOT retry genuine non-transient errors (e.g. 400/permission)", () => {
    expect(isTransientDbError(new Error("Supabase GET failed: 400 Bad Request"))).toBe(false);
    expect(isTransientDbError(new Error("permission denied for table ip_item_avg_cost"))).toBe(false);
    expect(isTransientDbError("relation does not exist")).toBe(false);
  });
});

describe("avgCostRowsToMap", () => {
  it("keeps positive numeric costs keyed by sku_code", () => {
    const m = avgCostRowsToMap([
      { sku_code: "RYB0412-BLACK", avg_cost: 5.5 },
      { sku_code: "RYB0412-NAVY", avg_cost: 6 },
    ]);
    expect(m.get("RYB0412-BLACK")).toBe(5.5);
    expect(m.get("RYB0412-NAVY")).toBe(6);
    expect(m.size).toBe(2);
  });
  it("drops blank sku, zero/negative, and non-numeric costs", () => {
    const m = avgCostRowsToMap([
      { sku_code: "", avg_cost: 5 },
      { sku_code: null, avg_cost: 5 },
      { sku_code: "A", avg_cost: 0 },
      { sku_code: "B", avg_cost: -1 },
      { sku_code: "C", avg_cost: null },
      { sku_code: "D", avg_cost: undefined },
      { sku_code: "E", avg_cost: 7 },
    ]);
    expect([...m.keys()]).toEqual(["E"]);
  });
  it("returns an empty map for no rows (a genuinely empty table)", () => {
    expect(avgCostRowsToMap([]).size).toBe(0);
  });
});
