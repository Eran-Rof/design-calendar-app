// CI regression net for the PO-grid grain wiring: mirrors the invariants that
// scripts/audit-pos.mjs checks against live data, but over a FIXTURE of the exact
// PO shapes that broke in prod — so a grain regression fails the build instead of
// reaching the grid. (The live audit — `npm run audit:pos` — is the data-drift
// check; this is the logic check.)
import { describe, it, expect } from "vitest";
import { computePoLineMoney } from "../index.js";

// Representative one-line shapes: [label, line, refs].  ppk from the size token.
const FIXTURE = [
  ["loose per-each", { qty_ordered: 100, unit_cost_cents: 715, ppk: 1, sku_code: "RYB161930-SANDLOT-30", style_id: "s1" }, { stdCost: 715, brandPrice: 900 }],
  ["pure-PPK pack cost (RCB1869, per-pack std)", { qty_ordered: 54, unit_cost_cents: 32400, ppk: 60, sku_code: "RCB1869NBDPPK-BLACK", style_id: "s2" }, { stdCost: 32400, recentSell: 40500 }],
  ["mixed garment+PPK (RYO0659, per-each std)", { qty_ordered: 203, unit_cost_cents: 21330, ppk: 18, sku_code: "RYO0659FP-SLATE", style_id: "s3", style_code: "RYO0659FP" }, { stdCost: 1185, recentSell: 1548 }],
  ["PPK brand list is per-pack (RYB1533)", { qty_ordered: 10, unit_cost_cents: 17160, ppk: 24, sku_code: "RYB153330PPK-SEAWEED", style_id: "s4", style_code: "RYB1533PPK" }, { stdCost: 17160, brandPrice: 21600 }],
  ["newly-linked pack (RYB1257, per-each std)", { qty_ordered: 94, unit_cost_cents: 12720, ppk: 24, sku_code: "RYB1257PPK-BLACK", style_id: "s5", style_code: "RYB1257PPK" }, { stdCost: 530, recentSell: 900 }],
];

describe("PO-grid grain invariants (fixture mirror of audit-pos.mjs)", () => {
  for (const [label, line, refs] of FIXTURE) {
    it(`${label}: per-each cost/price/sell all sane`, () => {
      const m = computePoLineMoney(line, refs);
      const poEach = m.priceCents / m.eaches;
      const costEach = m.costCents / m.eaches;
      // INVARIANT 1 — Avg cost and Avg PO price share grain: ratio in [0.5, 2].
      expect(costEach / poEach).toBeGreaterThanOrEqual(0.5);
      expect(costEach / poEach).toBeLessThanOrEqual(2.0);
      // INVARIANT 2 — per-each values are plausible apparel prices ($0.50–$500).
      expect(poEach).toBeGreaterThanOrEqual(50);
      expect(poEach).toBeLessThanOrEqual(50000);
      // INVARIANT 3 — margin, when sell resolves, is in a sane band (−20%..95%).
      if (m.sellCents != null) {
        const sellEach = m.sellCents / m.eaches;
        const margin = (sellEach - poEach) / sellEach;
        expect(margin).toBeGreaterThan(-0.2);
        expect(margin).toBeLessThan(0.95);
      }
    });
  }
});
