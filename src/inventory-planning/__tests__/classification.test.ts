import { describe, it, expect } from "vitest";
import { classifyAbcXyz } from "../compute/classification";
import type { IpSalesWholesaleRow } from "../types/entities";

type Sale = Pick<IpSalesWholesaleRow, "sku_id" | "qty" | "txn_date">;

const ASOF = "2026-04-15";

function s(sku: string, txn_date: string, qty: number): Sale {
  return { sku_id: sku, txn_date, qty };
}

// Helper: spread N sales evenly across the trailing 12 months for a SKU.
function steady(sku: string, perMonth: number): Sale[] {
  const out: Sale[] = [];
  for (let m = 4; m >= 1; m--) out.push(s(sku, `2026-${String(m).padStart(2, "0")}-15`, perMonth));
  for (let m = 12; m >= 5; m--) out.push(s(sku, `2025-${String(m).padStart(2, "0")}-15`, perMonth));
  return out;
}

describe("classifyAbcXyz", () => {
  it("ranks high-volume SKUs as A, mid as B, long-tail as C", () => {
    // SKU-A: 12000 (60% of total) — A (alone).
    // SKU-B:  6000 (30%) — A as well, brings cum to 90%.
    // SKU-C:  1500 (7.5%) — B, brings cum to 97.5%.
    // SKU-D:   500 (2.5%) — C, the tail.
    const sales: Sale[] = [
      ...steady("a", 1000),
      ...steady("b", 500),
      ...steady("c", 125),
      ...steady("d", 42),
    ];
    const out = classifyAbcXyz(sales, ASOF);
    expect(out.get("a")?.abc).toBe("A");
    expect(out.get("b")?.abc).toBe("A");
    expect(out.get("c")?.abc).toBe("B");
    expect(out.get("d")?.abc).toBe("C");
  });

  it("classifies steady demand as X (low CV)", () => {
    const sales: Sale[] = steady("a", 100);
    const out = classifyAbcXyz(sales, ASOF);
    expect(out.get("a")?.xyz).toBe("X");
    expect(out.get("a")?.active_months).toBe(12);
  });

  it("classifies highly variable demand as Z", () => {
    // Single big spike (1200 in one month) + 11 zero months → CV ~3.3 → Z.
    const sales: Sale[] = [s("a", "2026-04-15", 1200)];
    const out = classifyAbcXyz(sales, ASOF);
    expect(out.get("a")?.xyz).toBe("Z");
    expect(out.get("a")?.active_months).toBe(1);
  });

  it("only counts sales inside the trailing window", () => {
    // Old sales (2024) shouldn't influence the classification.
    const sales: Sale[] = [
      ...steady("a", 100),
      s("a", "2024-01-15", 999_999), // far outside window
    ];
    const out = classifyAbcXyz(sales, ASOF);
    expect(out.get("a")?.total_qty).toBe(1200); // 100 × 12 months only
  });

  it("respects custom thresholds — single-SKU dominant case", () => {
    const sales: Sale[] = [
      ...steady("a", 600), // 60%
      ...steady("b", 200), // 20% (cum 80%)
      ...steady("c", 200), // 20% (cum 100%)
    ];
    // Tighter A threshold (50%) → a alone is A. abcB = 0.85 → b joins B
    // (its prev=60% is < 85%); c's prev=80% < 85% → also B.
    const out = classifyAbcXyz(sales, ASOF, { abcA: 0.5, abcB: 0.85 });
    expect(out.get("a")?.abc).toBe("A");
    expect(out.get("b")?.abc).toBe("B");
    expect(out.get("c")?.abc).toBe("B");
  });

  it("empty input returns empty map", () => {
    expect(classifyAbcXyz([], ASOF).size).toBe(0);
  });
});
