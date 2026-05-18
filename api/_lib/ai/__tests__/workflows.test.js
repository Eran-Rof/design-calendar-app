// Unit tests for the workflow executor (Tier 3I).
// Pinned behaviours:
//   - workflowWindows produces valid T3 + LY ISO dates from a given "now".
//   - rankByRevenueDecline excludes zero-LY entries + entries with no decline,
//     ranks by % decline descending, caps at topN.
//   - rankByChurnRisk thresholds against the ratio (T3/LY), not absolute drop.
//   - tool_start_workflow returns a structured error for unknown workflows
//     and threads params through to the run() function correctly.

import { describe, it, expect } from "vitest";
import {
  workflowWindows,
  rankByRevenueDecline,
  rankByChurnRisk,
  tool_start_workflow,
  WORKFLOWS,
  listWorkflows,
} from "../workflows.js";

// ────────────────────────────────────────────────────────────────────────
// workflowWindows
// ────────────────────────────────────────────────────────────────────────

describe("workflowWindows", () => {
  it("produces T3 ending today + LY ending exactly one year earlier", () => {
    const now = new Date("2026-05-18T12:00:00Z");
    const w = workflowWindows(now);
    expect(w.t3End).toBe("2026-05-18");
    expect(w.lyEnd).toBe("2025-05-18");
  });

  it("T3 start is 3 months before T3 end", () => {
    const w = workflowWindows(new Date("2026-05-18T12:00:00Z"));
    expect(w.t3Start).toBe("2026-02-18");
  });

  it("LY start is 15 months before now (i.e. T3 shifted -12mo)", () => {
    const w = workflowWindows(new Date("2026-05-18T12:00:00Z"));
    expect(w.lyStart).toBe("2025-02-18");
  });
});

// ────────────────────────────────────────────────────────────────────────
// rankByRevenueDecline
// ────────────────────────────────────────────────────────────────────────

describe("rankByRevenueDecline", () => {
  it("excludes styles with zero LY revenue (no baseline)", () => {
    const m = new Map([
      ["A", { t3Revenue:  500, lyRevenue:    0, t3Qty: 10, lyQty:  0 }],
      ["B", { t3Revenue: 1000, lyRevenue: 2000, t3Qty: 50, lyQty: 100 }],
    ]);
    const r = rankByRevenueDecline(m, 10);
    expect(r.map(x => x.style_code)).toEqual(["B"]);
  });

  it("excludes styles where T3 >= LY (no decline)", () => {
    const m = new Map([
      ["A", { t3Revenue: 2000, lyRevenue: 1000, t3Qty: 10, lyQty: 5 }],
      ["B", { t3Revenue: 1000, lyRevenue: 2000, t3Qty: 50, lyQty: 100 }],
    ]);
    const r = rankByRevenueDecline(m, 10);
    expect(r.map(x => x.style_code)).toEqual(["B"]);
  });

  it("ranks by decline_pct descending and caps at topN", () => {
    const m = new Map([
      ["mild",   { t3Revenue: 800, lyRevenue: 1000, t3Qty: 0, lyQty: 0 }],  // -20%
      ["severe", { t3Revenue: 100, lyRevenue: 1000, t3Qty: 0, lyQty: 0 }],  // -90%
      ["medium", { t3Revenue: 500, lyRevenue: 1000, t3Qty: 0, lyQty: 0 }],  // -50%
    ]);
    const r = rankByRevenueDecline(m, 2);
    expect(r.map(x => x.style_code)).toEqual(["severe", "medium"]);
    expect(r[0].decline_pct).toBeCloseTo(90, 0);
    expect(r[1].decline_pct).toBeCloseTo(50, 0);
  });

  it("rounds money to whole dollars + decline_pct to one decimal", () => {
    const m = new Map([
      ["X", { t3Revenue: 333.5, lyRevenue: 1000.2, t3Qty: 7.3, lyQty: 20.6 }],
    ]);
    const r = rankByRevenueDecline(m, 10);
    expect(r[0].t3_revenue).toBe(334);
    expect(r[0].ly_revenue).toBe(1000);
    expect(r[0].t3_qty).toBe(7);
    expect(r[0].ly_qty).toBe(21);
    // decline = 1000.2 - 333.5 = 666.7 → pct = 0.66656... → 66.7
    expect(r[0].decline_pct).toBeCloseTo(66.7, 1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// rankByChurnRisk
// ────────────────────────────────────────────────────────────────────────

describe("rankByChurnRisk", () => {
  it("includes customers below the threshold ratio (T3/LY)", () => {
    // threshold = 0.75 means "keep if T3/LY <= 0.75"
    const m = new Map([
      ["healthy", { t3Revenue: 950, lyRevenue: 1000 }], // ratio 0.95 — excluded
      ["churn",   { t3Revenue: 400, lyRevenue: 1000 }], // ratio 0.40 — included
    ]);
    const r = rankByChurnRisk(m, 0.75, 10);
    expect(r.map(x => x.customer_id)).toEqual(["churn"]);
    expect(r[0].drop_pct).toBeCloseTo(60, 0);
  });

  it("excludes customers with zero LY revenue", () => {
    const m = new Map([
      ["new", { t3Revenue: 0, lyRevenue: 0 }],
    ]);
    const r = rankByChurnRisk(m, 0.75, 10);
    expect(r).toHaveLength(0);
  });

  it("ranks by drop_pct descending and caps at topN", () => {
    const m = new Map([
      ["mild",   { t3Revenue: 700, lyRevenue: 1000 }], // 30% drop
      ["severe", { t3Revenue: 100, lyRevenue: 1000 }], // 90% drop
      ["medium", { t3Revenue: 400, lyRevenue: 1000 }], // 60% drop
    ]);
    const r = rankByChurnRisk(m, 0.75, 2);
    expect(r.map(x => x.customer_id)).toEqual(["severe", "medium"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// tool_start_workflow
// ────────────────────────────────────────────────────────────────────────

describe("tool_start_workflow", () => {
  it("returns a structured error when workflow_name is missing", async () => {
    const out = await tool_start_workflow({}, {});
    expect(out.error).toMatch(/workflow_name/);
  });

  it("returns a structured error for unknown workflow and names the available ones", async () => {
    const out = await tool_start_workflow({}, { workflow_name: "not_a_real_workflow" });
    expect(out.error).toMatch(/Unknown workflow/);
    expect(out.error).toMatch(/underperformer_review/);
    expect(out.error).toMatch(/customer_churn_check/);
    expect(out.error).toMatch(/monday_briefing/);
  });

  it("catches errors thrown inside a workflow and returns structured error", async () => {
    // Hijack the WORKFLOWS map temporarily by mocking a tiny db whose
    // .from() throws. underperformer_review will hit that immediately.
    const throwingDb = {
      from() { throw new Error("simulated outage"); },
    };
    const out = await tool_start_workflow(throwingDb, { workflow_name: "underperformer_review" });
    expect(out.error).toMatch(/underperformer_review/);
    expect(out.error).toMatch(/simulated outage/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// listWorkflows / registry shape
// ────────────────────────────────────────────────────────────────────────

describe("workflow registry", () => {
  it("exposes the three starter workflows with name + description", () => {
    const list = listWorkflows();
    const names = list.map(w => w.name).sort();
    expect(names).toEqual([
      "customer_churn_check",
      "monday_briefing",
      "underperformer_review",
    ]);
    for (const w of list) {
      expect(typeof w.name).toBe("string");
      expect(typeof w.description).toBe("string");
      expect(w.description.length).toBeGreaterThan(30);
    }
  });

  it("every workflow has a callable run() function", () => {
    for (const w of WORKFLOWS) {
      expect(typeof w.run).toBe("function");
    }
  });
});
