// Unit tests for the proactive-insight rules (Tier 3K).
// Pinned behaviours that must NOT regress:
//   - Customer churn requires BOTH a % drop AND an absolute $ floor on
//     the prior period (tiny accounts ignored).
//   - Style runaway requires a T30 floor so brand-new styles don't all
//     look like infinite lifts.
//   - Style decline requires open-PO exposure — without it, the insight
//     isn't actionable (just a reporting fact).
//   - Dedupe keys are week-stable so the same signal fires once per week
//     even if the cron runs daily.
//   - Severity tiers up at clear thresholds (50%+ churn = urgent, 4x+
//     runaway = urgent) so the UI can prioritise.

import { describe, it, expect } from "vitest";
import {
  weekKey,
  round,
  detectCustomerChurnSignals,
  detectStyleRunaways,
  detectStyleDeclines,
} from "../proactive-rules.js";

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

describe("weekKey", () => {
  it("returns the same ISO date for any day in the same Mon-Sun week", () => {
    // Mon May 18 2026 → Sun May 24 2026 should all map to 2026-05-18.
    expect(weekKey(new Date("2026-05-18T00:00:00Z"))).toBe("2026-05-18");
    expect(weekKey(new Date("2026-05-21T12:00:00Z"))).toBe("2026-05-18");
    expect(weekKey(new Date("2026-05-24T23:59:00Z"))).toBe("2026-05-18");
  });

  it("rolls forward to the next Monday on Mon 00:00", () => {
    expect(weekKey(new Date("2026-05-25T00:00:00Z"))).toBe("2026-05-25");
  });
});

describe("round", () => {
  it("defaults to 1 decimal", () => {
    expect(round(12.345)).toBe(12.3);
  });
  it("respects decimals arg", () => {
    expect(round(12.345, 2)).toBe(12.35);
    expect(round(12.345, 0)).toBe(12);
  });
});

// ────────────────────────────────────────────────────────────────────────
// detectCustomerChurnSignals
// ────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-05-18T00:00:00Z");

describe("detectCustomerChurnSignals", () => {
  it("flags a customer whose T30 dropped 50% from $20k → $10k", () => {
    const m = new Map([
      ["c-burlington", { name: "Burlington", p30Revenue: 20000, t30Revenue: 10000 }],
    ]);
    const out = detectCustomerChurnSignals(m, { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].subject_id).toBe("c-burlington");
    expect(out[0].severity).toBe("urgent");           // 50% triggers urgent
    expect(out[0].metrics.drop_pct).toBeCloseTo(50, 0);
    expect(out[0].dedupe_key).toBe("customer_churn_signal:c-burlington:2026-05-18");
  });

  it("uses warn severity for drops below 50%", () => {
    const m = new Map([
      ["c", { name: "Smallish", p30Revenue: 20000, t30Revenue: 12000 }],
    ]);
    const out = detectCustomerChurnSignals(m, { now: NOW });
    expect(out[0].severity).toBe("warn");
  });

  it("ignores customers under the $10k P30 floor (avoids tiny-account noise)", () => {
    const m = new Map([
      ["small", { name: "Boutique", p30Revenue: 5000, t30Revenue: 500 }], // 90% drop but tiny → skip
      ["real",  { name: "Real",     p30Revenue: 30000, t30Revenue: 3000 }], // 90% drop, real → flag
    ]);
    const out = detectCustomerChurnSignals(m, { now: NOW });
    expect(out.map(i => i.subject_id)).toEqual(["real"]);
  });

  it("ignores customers below the drop threshold (default 25%)", () => {
    const m = new Map([
      ["steady", { name: "Steady", p30Revenue: 20000, t30Revenue: 16000 }], // 20% drop → ignore
    ]);
    expect(detectCustomerChurnSignals(m, { now: NOW })).toHaveLength(0);
  });

  it("honours custom dropThresholdPct + minPriorRevenue overrides", () => {
    const m = new Map([
      ["a", { p30Revenue: 1000, t30Revenue: 800 }], // 20% drop
    ]);
    const out = detectCustomerChurnSignals(m, { now: NOW, dropThresholdPct: 15, minPriorRevenue: 500 });
    expect(out).toHaveLength(1);
  });

  it("ranks results most-severe first", () => {
    const m = new Map([
      ["mild",   { name: "Mild",   p30Revenue: 20000, t30Revenue: 14000 }], // 30%
      ["severe", { name: "Severe", p30Revenue: 20000, t30Revenue:  2000 }], // 90%
    ]);
    const out = detectCustomerChurnSignals(m, { now: NOW });
    expect(out.map(i => i.subject_id)).toEqual(["severe", "mild"]);
  });

  it("falls back to customer_id when name is missing", () => {
    const m = new Map([
      ["nameless-uuid-here", { p30Revenue: 30000, t30Revenue: 10000 }],
    ]);
    const out = detectCustomerChurnSignals(m, { now: NOW });
    expect(out[0].subject_label).toBe("nameless-uuid-here");
  });
});

// ────────────────────────────────────────────────────────────────────────
// detectStyleRunaways
// ────────────────────────────────────────────────────────────────────────

describe("detectStyleRunaways", () => {
  it("flags a style whose T7 daily-avg is ≥ 2.5× T30 daily-avg", () => {
    // T30 = 60 over 30 days → 2/day. T7 = 35 over 7 → 5/day. Lift 2.5x → fire.
    const m = new Map([
      ["RYB0412", { t7Qty: 35, t30Qty: 60 }],
    ]);
    const out = detectStyleRunaways(m, { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].subject_id).toBe("RYB0412");
    expect(out[0].metrics.lift_x).toBeCloseTo(2.5, 1);
  });

  it("ignores styles under the T30 floor of 50 units", () => {
    const m = new Map([
      ["new", { t7Qty: 20, t30Qty: 30 }],   // T30 < 50 → skip even though lift is huge
    ]);
    expect(detectStyleRunaways(m, { now: NOW })).toHaveLength(0);
  });

  it("uses urgent severity at lift ≥ 4×", () => {
    const m = new Map([
      ["A", { t7Qty: 50, t30Qty: 60 }],  // T7=7.14/d, T30=2/d → lift 3.57 → info
      ["B", { t7Qty: 60, t30Qty: 60 }],  // T7=8.57/d, T30=2/d → lift 4.29 → urgent
    ]);
    const out = detectStyleRunaways(m, { now: NOW });
    const sevA = out.find(i => i.subject_id === "A")?.severity;
    const sevB = out.find(i => i.subject_id === "B")?.severity;
    expect(sevA).toBe("info");
    expect(sevB).toBe("urgent");
  });

  it("caps at topN, biggest lift first", () => {
    const m = new Map([
      ["mid",  { t7Qty: 28, t30Qty: 60 }], // lift 2.0 → below threshold actually
      ["big",  { t7Qty: 60, t30Qty: 60 }], // lift ~4.29
      ["bigger", { t7Qty: 80, t30Qty: 60 }], // lift 5.71
    ]);
    const out = detectStyleRunaways(m, { now: NOW, topN: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].subject_id).toBe("bigger");
  });

  it("dedupe key is week-stable", () => {
    const m = new Map([["RYB0412", { t7Qty: 35, t30Qty: 60 }]]);
    const tueWed = detectStyleRunaways(m, { now: new Date("2026-05-19T00:00:00Z") });
    const friSat = detectStyleRunaways(m, { now: new Date("2026-05-23T00:00:00Z") });
    expect(tueWed[0].dedupe_key).toBe(friSat[0].dedupe_key);
  });
});

// ────────────────────────────────────────────────────────────────────────
// detectStyleDeclines
// ────────────────────────────────────────────────────────────────────────

describe("detectStyleDeclines", () => {
  it("flags a style whose T7 daily-avg ≤ 30% of T30 daily-avg AND has open POs", () => {
    // T30 = 300 over 30 → 10/d. T7 = 14 over 7 → 2/d → ratio 0.2 → flag.
    const m = new Map([
      ["RBB0911", { t7Qty: 14, t30Qty: 300, openPoQty: 100 }],
    ]);
    const out = detectStyleDeclines(m, { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].subject_id).toBe("RBB0911");
    expect(out[0].metrics.drop_pct).toBeCloseTo(80, 0);
  });

  it("ignores a declining style with NO open-PO exposure (not actionable)", () => {
    const m = new Map([
      ["x", { t7Qty: 14, t30Qty: 300, openPoQty: 0 }],
    ]);
    expect(detectStyleDeclines(m, { now: NOW })).toHaveLength(0);
  });

  it("ignores styles under the T30 floor of 100 units", () => {
    const m = new Map([
      ["small", { t7Qty: 1, t30Qty: 30, openPoQty: 200 }],
    ]);
    expect(detectStyleDeclines(m, { now: NOW })).toHaveLength(0);
  });

  it("ignores when T7 ratio is above maxRatio (not declining enough)", () => {
    const m = new Map([
      ["ok", { t7Qty: 70, t30Qty: 300, openPoQty: 200 }], // ratio 1.0 → skip
    ]);
    expect(detectStyleDeclines(m, { now: NOW })).toHaveLength(0);
  });

  it("ranks by drop_pct descending", () => {
    const m = new Map([
      ["mild",   { t7Qty: 21, t30Qty: 300, openPoQty: 200 }], // ratio 0.3 (borderline; meets =0.3 exactly)
      ["severe", { t7Qty: 0,  t30Qty: 300, openPoQty: 200 }], // 100% drop
    ]);
    const out = detectStyleDeclines(m, { now: NOW });
    expect(out[0].subject_id).toBe("severe");
  });
});
