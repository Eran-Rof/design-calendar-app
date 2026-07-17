import { describe, it, expect, vi, beforeEach } from "vitest";

// generatePlannerBuyPlanForRun writes buy recommendations AND records a
// run-level approval so the execution batch builder's approval gate passes
// for direct-run buy-plan batches. These tests mock the three repos it
// touches and assert the approval row is created with the right shape.

const listForecast = vi.fn();
const listItems = vi.fn();
const replaceRecommendations = vi.fn();
const createApproval = vi.fn();

vi.mock("../services/wholesalePlanningRepository", () => ({
  wholesaleRepo: {
    listForecast: (...a: unknown[]) => listForecast(...a),
    listItems: (...a: unknown[]) => listItems(...a),
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

beforeEach(() => {
  listForecast.mockReset();
  listItems.mockReset();
  replaceRecommendations.mockReset();
  createApproval.mockReset();
  listItems.mockResolvedValue([{ id: "sku-a", category_id: "cat-1" }]);
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
    expect(r).toEqual({ recommendations: 1, units: 15 });

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

  it("records the approval even when there are no typed buys (empty buy plan)", async () => {
    listForecast.mockResolvedValue([fc({ planned_buy_qty: 0 })]);

    const r = await generatePlannerBuyPlanForRun("run-1");

    expect(r).toEqual({ recommendations: 0, units: 0 });
    expect(replaceRecommendations).toHaveBeenCalledWith("run-1", []);
    // Approval is still recorded — finalizing an empty plan still approves
    // the run so downstream gates behave consistently.
    expect(createApproval).toHaveBeenCalledTimes(1);
    expect(createApproval.mock.calls[0][0].approval_status).toBe("approved");
  });
});
