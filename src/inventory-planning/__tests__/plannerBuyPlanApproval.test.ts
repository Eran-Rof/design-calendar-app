import { describe, it, expect, vi, beforeEach } from "vitest";

// generatePlannerBuyPlanForRun writes buy recommendations AND records a
// run-level approval so the execution batch builder's approval gate passes
// for direct-run buy-plan batches. It reads typed buys from BOTH the
// forecast table and the TBD stock-buy table (ip_wholesale_forecast_tbd),
// resolving TBD style+color to a real SKU at BASE-COLOR grain. These tests
// mock the repos it touches.

const listForecast = vi.fn();
const listItems = vi.fn();
const listTbdRows = vi.fn();
const replaceRecommendations = vi.fn();
const createApproval = vi.fn();

vi.mock("../services/wholesalePlanningRepository", () => ({
  wholesaleRepo: {
    listForecast: (...a: unknown[]) => listForecast(...a),
    listItems: (...a: unknown[]) => listItems(...a),
    listTbdRows: (...a: unknown[]) => listTbdRows(...a),
  },
}));
vi.mock("../supply/services/supplyReconciliationRepo", () => ({
  supplyRepo: {
    replaceRecommendations: (...a: unknown[]) => replaceRecommendations(...a),
  },
}));
vi.mock("../scenarios/services/scenarioRepo", () => ({
  scenarioRepo: {
    createApproval: (...a: unknown[]) => createApproval(...a),
  },
}));
// currentUserEmail reads localStorage; in the node test env window is
// undefined so it returns "admin@local". Pin it for a stable assertion.
vi.mock("../governance/services/permissionService", () => ({
  currentUserEmail: () => "planner@rof.com",
}));

import { generatePlannerBuyPlanForRun } from "../scenarios/services/scenarioService";

function fc(partial: Record<string, unknown>) {
  return {
    planning_run_id: "run-1",
    customer_id: "cust-1",
    category_id: "cat-1",
    sku_id: "sku-a",
    period_start: "2026-05-01",
    period_end: "2026-05-31",
    period_code: "2026-05",
    system_forecast_qty: 0,
    buyer_request_qty: 0,
    override_qty: null,
    final_forecast_qty: 0,
    confidence_level: "estimate",
    forecast_method: "ly_sales",
    history_months_used: 0,
    notes: null,
    planned_buy_qty: 0,
    ...partial,
  };
}

function tbd(partial: Record<string, unknown>) {
  return {
    id: "tbd-1",
    planning_run_id: "run-1",
    style_code: "RYB0412",
    color: "Navy",
    is_new_color: false,
    is_user_added: true,
    customer_id: "cust-1",
    group_name: null,
    sub_category_name: null,
    period_start: "2026-05-01",
    period_end: "2026-05-31",
    period_code: "2026-05",
    buyer_request_qty: 0,
    override_qty: 0,
    final_forecast_qty: 0,
    planned_buy_qty: 0,
    unit_cost: null,
    notes: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...partial,
  };
}

beforeEach(() => {
  listForecast.mockReset();
  listItems.mockReset();
  listTbdRows.mockReset();
  replaceRecommendations.mockReset();
  createApproval.mockReset();
  listForecast.mockResolvedValue([]);
  listTbdRows.mockResolvedValue([]);
  listItems.mockResolvedValue([
    { id: "sku-a", sku_code: "RBB1440N-BLACK", category_id: "cat-1" },
    { id: "sku-navy", sku_code: "RYB0412-NAVY", category_id: "cat-2" },
    { id: "sku-camo", sku_code: "RYB0412-TONALGREYCAMO", category_id: "cat-2" },
  ]);
  replaceRecommendations.mockResolvedValue(undefined);
  createApproval.mockResolvedValue({ id: "appr-1" });
});

describe("generatePlannerBuyPlanForRun auto-approval", () => {
  it("records a run-level 'approved' approval after writing recommendations", async () => {
    listForecast.mockResolvedValue([
      fc({ sku_id: "sku-a", planned_buy_qty: 10 }),
      fc({ sku_id: "sku-a", customer_id: "cust-2", planned_buy_qty: 5 }),
    ]);

    const r = await generatePlannerBuyPlanForRun("run-1");

    // Recs written first (one aggregated (sku, period) line, 15 units).
    expect(replaceRecommendations).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ recommendations: 1, units: 15, skippedTbdLines: 0, skippedTbdUnits: 0 });

    // Then exactly one approval row, run-scoped and approved.
    expect(createApproval).toHaveBeenCalledTimes(1);
    const row = createApproval.mock.calls[0][0];
    expect(row.planning_run_id).toBe("run-1");
    expect(row.scenario_id).toBeNull();
    expect(row.approval_status).toBe("approved");
    expect(row.approved_by).toBe("planner@rof.com");
    expect(typeof row.approved_at).toBe("string");
    expect(row.note).toMatch(/auto-approved/i);
  });

  it("is a true no-op when there are no typed buys — no wipe, no approval", async () => {
    listForecast.mockResolvedValue([fc({ planned_buy_qty: 0 })]);

    const r = await generatePlannerBuyPlanForRun("run-1");

    expect(r).toEqual({ recommendations: 0, units: 0, skippedTbdLines: 0, skippedTbdUnits: 0 });
    // An empty push must not destroy existing recommendations, and must
    // not stamp an approval on a plan that was never actually finalized.
    expect(replaceRecommendations).not.toHaveBeenCalled();
    expect(createApproval).not.toHaveBeenCalled();
  });
});

describe("generatePlannerBuyPlanForRun TBD stock-buy rows", () => {
  it("includes TBD buys resolved to a real SKU at BASE-COLOR grain", async () => {
    listTbdRows.mockResolvedValue([
      tbd({ style_code: "RYB0412", color: "Navy", planned_buy_qty: 100 }),
    ]);

    const r = await generatePlannerBuyPlanForRun("run-1");

    expect(r).toEqual({ recommendations: 1, units: 100, skippedTbdLines: 0, skippedTbdUnits: 0 });
    const rows = replaceRecommendations.mock.calls[0][1];
    expect(rows).toHaveLength(1);
    expect(rows[0].sku_id).toBe("sku-navy");
    expect(rows[0].category_id).toBe("cat-2");
    expect(rows[0].recommendation_qty).toBe(100);
    expect(rows[0].action_reason).toBe("planner_buy_plan");
    expect(createApproval).toHaveBeenCalledTimes(1);
  });

  it("matches multi-word colors against concatenated sku suffixes", async () => {
    // Grid color "Tonal Grey Camo" ↔ sku_code "RYB0412-TONALGREYCAMO".
    listTbdRows.mockResolvedValue([
      tbd({ style_code: "RYB0412", color: "Tonal Grey Camo", planned_buy_qty: 48 }),
    ]);

    const r = await generatePlannerBuyPlanForRun("run-1");

    expect(r.recommendations).toBe(1);
    expect(replaceRecommendations.mock.calls[0][1][0].sku_id).toBe("sku-camo");
  });

  it("aggregates forecast and TBD buys landing on the same (sku, period)", async () => {
    listForecast.mockResolvedValue([fc({ sku_id: "sku-navy", category_id: "cat-2", planned_buy_qty: 20 })]);
    listTbdRows.mockResolvedValue([
      tbd({ style_code: "RYB0412", color: "NAVY", planned_buy_qty: 30 }),
    ]);

    const r = await generatePlannerBuyPlanForRun("run-1");

    expect(r).toEqual({ recommendations: 1, units: 50, skippedTbdLines: 0, skippedTbdUnits: 0 });
    expect(replaceRecommendations.mock.calls[0][1][0].recommendation_qty).toBe(50);
  });

  it("counts unresolvable TBD buys as skipped and still pushes the rest", async () => {
    listTbdRows.mockResolvedValue([
      tbd({ style_code: "RYB0412", color: "Navy", planned_buy_qty: 60 }),
      tbd({ id: "tbd-2", style_code: "RYB0412", color: "Sunset Coral", is_new_color: true, planned_buy_qty: 40 }),
    ]);

    const r = await generatePlannerBuyPlanForRun("run-1");

    expect(r).toEqual({ recommendations: 1, units: 60, skippedTbdLines: 1, skippedTbdUnits: 40 });
    expect(createApproval).toHaveBeenCalledTimes(1);
  });

  it("does not approve when every typed buy is an unresolvable TBD row", async () => {
    listTbdRows.mockResolvedValue([
      tbd({ style_code: "RYB0412", color: "Sunset Coral", is_new_color: true, planned_buy_qty: 40 }),
    ]);

    const r = await generatePlannerBuyPlanForRun("run-1");

    expect(r).toEqual({ recommendations: 0, units: 0, skippedTbdLines: 1, skippedTbdUnits: 40 });
    expect(replaceRecommendations).not.toHaveBeenCalled();
    expect(createApproval).not.toHaveBeenCalled();
  });
});

describe("generatePlannerBuyPlanForRun onProgress", () => {
  it("fires the expected stage sequence on a run with forecast + TBD buys", async () => {
    listForecast.mockResolvedValue([fc({ sku_id: "sku-a", planned_buy_qty: 10 })]);
    listTbdRows.mockResolvedValue([
      tbd({ style_code: "RYB0412", color: "Navy", planned_buy_qty: 60 }),
      tbd({ id: "tbd-2", style_code: "RYB0412", color: "Sunset Coral", is_new_color: true, planned_buy_qty: 40 }),
    ]);

    const events: Array<{ stage: string; detail?: string; current?: number; total?: number }> = [];
    const r = await generatePlannerBuyPlanForRun("run-1", (p) => events.push(p));

    // The push itself still behaves exactly as before.
    expect(r).toEqual({ recommendations: 2, units: 70, skippedTbdLines: 1, skippedTbdUnits: 40 });

    // Stage labels appear in the documented order.
    const stages = events.map((e) => e.stage);
    expect(stages).toEqual([
      "Reading typed buys…",
      "Reading typed buys…",
      "Reading TBD stock-buy rows…",
      "Resolving TBD rows to SKUs…",
      "Resolving TBD rows to SKUs…",
      "Writing buy plan… (2 lines)",
      "Approving run…",
    ]);

    // The resolve summary reports resolved/skipped counts.
    const resolveDone = events.find((e) => e.stage === "Resolving TBD rows to SKUs…" && e.detail);
    expect(resolveDone?.detail).toBe("1 resolved · 1 skipped");
  });

  it("works with onProgress omitted (default no-op)", async () => {
    listForecast.mockResolvedValue([fc({ sku_id: "sku-a", planned_buy_qty: 10 })]);

    const r = await generatePlannerBuyPlanForRun("run-1");

    expect(r).toEqual({ recommendations: 1, units: 10, skippedTbdLines: 0, skippedTbdUnits: 0 });
    expect(createApproval).toHaveBeenCalledTimes(1);
  });

  it("emits Writing before Approving, and both come after the reads", async () => {
    listForecast.mockResolvedValue([fc({ sku_id: "sku-a", planned_buy_qty: 5 })]);

    const stages: string[] = [];
    await generatePlannerBuyPlanForRun("run-1", (p) => stages.push(p.stage));

    const writeIdx = stages.findIndex((s) => s.startsWith("Writing buy plan…"));
    const approveIdx = stages.indexOf("Approving run…");
    const firstReadIdx = stages.indexOf("Reading typed buys…");
    expect(firstReadIdx).toBe(0);
    expect(writeIdx).toBeGreaterThan(firstReadIdx);
    expect(approveIdx).toBeGreaterThan(writeIdx);
  });
});
