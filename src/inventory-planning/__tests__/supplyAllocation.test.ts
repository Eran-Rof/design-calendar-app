import { describe, it, expect } from "vitest";
import { computeAllocation, splitAllocation } from "../supply/compute/allocationEngine";
import { buildProjectedInventory, totalAvailableSupply } from "../supply/compute/supplyReconciliation";
import type {
  DemandInputsForSku,
  IpAllocationRule,
  SupplyInputsForSku,
  ReconciliationInput,
} from "../supply/types/supply";

const RUN = "run-recon";
const SKU = "sku-a";

function supply(partial: Partial<SupplyInputsForSku> = {}): SupplyInputsForSku {
  return {
    sku_id: SKU,
    beginning_on_hand_qty: 0, ats_qty: 0,
    inbound_receipts_qty: 0, inbound_po_qty: 0, wip_qty: 0,
    ...partial,
  };
}

function demand(partial: Partial<DemandInputsForSku> = {}): DemandInputsForSku {
  return {
    sku_id: SKU,
    wholesale_demand_qty: 0, ecom_demand_qty: 0, protected_ecom_qty: 0,
    wholesale_by_customer: [], ecom_by_channel: [],
    ...partial,
  };
}

function rule(partial: Partial<IpAllocationRule> = {}): IpAllocationRule {
  return {
    id: "rule-x",
    rule_name: "R",
    rule_type: "reserve_wholesale",
    priority_rank: 100,
    applies_to_customer_id: null, applies_to_channel_id: null,
    applies_to_category_id: null, applies_to_sku_id: null,
    reserve_qty: null, reserve_percent: null,
    protection_flag: true,
    note: null,
    active: true,
    created_at: "2026-04-19T00:00:00Z",
    updated_at: "2026-04-19T00:00:00Z",
    ...partial,
  };
}

// ── totalAvailableSupply ────────────────────────────────────────────────────
describe("totalAvailableSupply", () => {
  it("uses ats_qty when set (month 1), beginning_on_hand_qty otherwise (months 2+)", () => {
    // ats_qty > 0 → use it (net of existing SO commitments)
    expect(totalAvailableSupply(supply({
      beginning_on_hand_qty: 100, ats_qty: 80,
      inbound_receipts_qty: 20, inbound_po_qty: 30, wip_qty: 10,
    }))).toBe(140); // 80 + 20 + 30 + 10
    // ats_qty = 0 → use beginning_on_hand_qty (rolled ending balance)
    expect(totalAvailableSupply(supply({
      beginning_on_hand_qty: 100, ats_qty: 0,
      inbound_receipts_qty: 20, inbound_po_qty: 30, wip_qty: 10,
    }))).toBe(160); // 100 + 20 + 30 + 10
  });
  it("clamps negatives", () => {
    expect(totalAvailableSupply(supply({ beginning_on_hand_qty: -5, inbound_po_qty: 10 }))).toBe(10);
  });
});

// ── computeAllocation ──────────────────────────────────────────────────────
describe("computeAllocation — waterfall order", () => {
  it("supply exceeds demand → ending inventory positive, no shortage", () => {
    const r = computeAllocation(300, demand({ wholesale_demand_qty: 100, ecom_demand_qty: 50 }), []);
    expect(r.allocated_total_qty).toBe(150);
    expect(r.ending_inventory_qty).toBe(150);
    expect(r.shortage_qty).toBe(0);
    expect(r.excess_qty).toBe(150);
    expect(r.projected_stockout_flag).toBe(false);
  });

  it("demand exceeds supply → shortage, stockout flag", () => {
    const r = computeAllocation(50, demand({ wholesale_demand_qty: 100, ecom_demand_qty: 50 }), []);
    expect(r.allocated_total_qty).toBe(50);
    expect(r.ending_inventory_qty).toBe(0);
    expect(r.shortage_qty).toBe(100);
    expect(r.projected_stockout_flag).toBe(true);
  });

  it("protected ecom fully covered when supply allows", () => {
    const r = computeAllocation(200, demand({
      wholesale_demand_qty: 50, ecom_demand_qty: 100, protected_ecom_qty: 40,
    }), []);
    expect(r.protected_ecom_qty).toBe(40);
    expect(r.allocated_ecom_qty).toBeGreaterThanOrEqual(40);
    // trace order: start, reserve_wholesale, protect_ecom, ...
    expect(r.trace.map((t) => t.step).slice(0, 3)).toEqual(["start", "reserve_wholesale", "protect_ecom"]);
  });

  it("protected ecom NOT covered when supply runs out first", () => {
    // supply 30, reserved_wholesale=0, protected=50, demand=100 ecom
    const r = computeAllocation(30, demand({ ecom_demand_qty: 100, protected_ecom_qty: 50 }), []);
    expect(r.protected_ecom_qty).toBe(30);
    expect(r.shortage_qty).toBe(70);
  });

  it("strategic customer reserve covered when supply allows", () => {
    const rules = [rule({ rule_type: "strategic_customer", reserve_qty: 40 })];
    const r = computeAllocation(200, demand({ wholesale_demand_qty: 100, ecom_demand_qty: 80 }), rules);
    expect(r.reserved_wholesale_qty).toBe(40);
    // wholesale remainder = 60; ecom remainder = 80; total allocated = 40 + 60 + 80 = 180
    expect(r.allocated_total_qty).toBe(180);
    expect(r.ending_inventory_qty).toBe(20);
  });

  it("strategic customer reserve NOT covered when supply low", () => {
    const rules = [rule({ rule_type: "strategic_customer", reserve_qty: 80 })];
    const r = computeAllocation(30, demand({ wholesale_demand_qty: 100, ecom_demand_qty: 50 }), rules);
    // All 30 goes to reserve target (capped at supply)
    expect(r.reserved_wholesale_qty).toBe(30);
    // Shortfall = 80 - 30 = 50 (reserve not covered); caller computes that
  });

  it("reserve percent works proportionally to wholesale demand", () => {
    const rules = [rule({ rule_type: "reserve_wholesale", reserve_percent: 0.25 })];
    const r = computeAllocation(500, demand({ wholesale_demand_qty: 200, ecom_demand_qty: 100 }), rules);
    expect(r.reserved_wholesale_qty).toBe(50); // 25% of 200
  });

  it("reserve_qty wins over reserve_percent when both set", () => {
    const rules = [rule({ rule_type: "reserve_wholesale", reserve_qty: 10, reserve_percent: 0.5 })];
    const r = computeAllocation(100, demand({ wholesale_demand_qty: 80 }), rules);
    expect(r.reserved_wholesale_qty).toBe(10);
  });

  it("cap_ecom rule limits remaining ecom allocation", () => {
    const rules = [rule({ rule_type: "cap_ecom", reserve_qty: 20 })];
    const r = computeAllocation(200, demand({ ecom_demand_qty: 100, protected_ecom_qty: 10 }), rules);
    // protected=10, cap=20 → remaining cap = 10; total ecom allocated = 20
    expect(r.allocated_ecom_qty).toBe(20);
    expect(r.ending_inventory_qty).toBe(180);
  });

  it("inactive rules are ignored (filtered upstream by activeRulesForSku)", () => {
    const rules = [rule({ rule_type: "reserve_wholesale", reserve_qty: 50, active: false })];
    // Compute still sees them here if the caller didn't filter.
    // But it still applies them because computeAllocation trusts its caller.
    const r = computeAllocation(100, demand({ wholesale_demand_qty: 100 }), rules);
    expect(r.reserved_wholesale_qty).toBe(50);
    // (This is intentional: filtering happens in activeRulesForSku.)
  });

  it("zero-supply edge case produces no allocation", () => {
    const r = computeAllocation(0, demand({ wholesale_demand_qty: 50, ecom_demand_qty: 50 }), []);
    expect(r.allocated_total_qty).toBe(0);
    expect(r.shortage_qty).toBe(100);
    expect(r.projected_stockout_flag).toBe(true);
  });

  it("zero-demand produces excess and no stockout", () => {
    const r = computeAllocation(100, demand({}), []);
    expect(r.shortage_qty).toBe(0);
    expect(r.excess_qty).toBe(100);
    expect(r.projected_stockout_flag).toBe(false);
  });
});

// ── buildProjectedInventory (end-to-end) ───────────────────────────────────
describe("buildProjectedInventory", () => {
  it("excess path: ending_inventory = total_supply - allocated_total", () => {
    const input: ReconciliationInput = {
      planning_run_id: RUN,
      period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
      sku_id: SKU, category_id: null,
      supply: supply({ beginning_on_hand_qty: 200, inbound_po_qty: 100 }),
      demand: demand({ wholesale_demand_qty: 120, ecom_demand_qty: 80 }),
      rules: [],
    };
    const row = buildProjectedInventory(input);
    expect(row.total_available_supply_qty).toBe(300);
    expect(row.allocated_total_qty).toBe(200);
    expect(row.ending_inventory_qty).toBe(100);
    expect(row.excess_qty).toBe(100);
    expect(row.projected_stockout_flag).toBe(false);
  });

  it("shortage path: stockout flag, shortage = demand - allocated", () => {
    const input: ReconciliationInput = {
      planning_run_id: RUN,
      period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
      sku_id: SKU, category_id: null,
      supply: supply({ beginning_on_hand_qty: 50 }),
      demand: demand({ wholesale_demand_qty: 80, ecom_demand_qty: 40 }),
      rules: [],
    };
    const row = buildProjectedInventory(input);
    expect(row.projected_stockout_flag).toBe(true);
    expect(row.shortage_qty).toBe(70);
    expect(row.ending_inventory_qty).toBe(0);
  });
});

// ── splitAllocation ────────────────────────────────────────────────────────
describe("splitAllocation", () => {
  it("splits proportionally, remainders on largest bucket", () => {
    const out = splitAllocation(100, [
      { key: "A", demand: 60 },
      { key: "B", demand: 30 },
      { key: "C", demand: 10 },
    ]);
    const total = out.reduce((a, b) => a + b.allocated, 0);
    expect(total).toBe(100);
    expect(out.find((o) => o.key === "A")!.allocated).toBeGreaterThan(out.find((o) => o.key === "B")!.allocated);
  });
  it("zero demand returns zeros", () => {
    const out = splitAllocation(100, [{ key: "A", demand: 0 }, { key: "B", demand: 0 }]);
    expect(out.every((o) => o.allocated === 0)).toBe(true);
  });
});
