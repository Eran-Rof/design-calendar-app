import { describe, it, expect } from "vitest";
import { generateInventoryRecommendations } from "../supply/compute/recommendationEngine";
import { generateSupplyExceptions } from "../supply/compute/exceptionEngine";
import type { IpProjectedInventory } from "../supply/types/supply";

function proj(partial: Partial<Omit<IpProjectedInventory, "id" | "created_at">>): Omit<IpProjectedInventory, "id" | "created_at"> {
  return {
    planning_run_id: "run-1",
    sku_id: "sku-a",
    category_id: null,
    period_start: "2026-05-01",
    period_end: "2026-05-31",
    period_code: "2026-05",
    beginning_on_hand_qty: 0, ats_qty: 0,
    inbound_receipts_qty: 0, inbound_po_qty: 0, wip_qty: 0,
    total_available_supply_qty: 0,
    wholesale_demand_qty: 0, ecom_demand_qty: 0,
    protected_ecom_qty: 0, reserved_wholesale_qty: 0,
    allocated_total_qty: 0, allocated_wholesale_qty: 0, allocated_ecom_qty: 0,
    ending_inventory_qty: 0,
    shortage_qty: 0, excess_qty: 0,
    projected_stockout_flag: false,
    ...partial,
  };
}

describe("generateInventoryRecommendations", () => {
  it("shortage far enough out → buy (high priority)", () => {
    const row = proj({
      total_available_supply_qty: 50, wholesale_demand_qty: 50, ecom_demand_qty: 50,
      allocated_total_qty: 50, shortage_qty: 50, projected_stockout_flag: true,
    });
    const recs = generateInventoryRecommendations([row], "2026-01-01");
    expect(recs[0].recommendation_type).toBe("buy");
    expect(recs[0].priority_level).toBe("critical"); // 50% of total demand
    expect(recs[0].service_risk_flag).toBe(true);
  });

  it("shortage within 30 days → expedite", () => {
    const row = proj({
      period_start: "2026-06-01", period_end: "2026-06-30",
      total_available_supply_qty: 90, wholesale_demand_qty: 100, ecom_demand_qty: 20,
      allocated_total_qty: 90, shortage_qty: 30, projected_stockout_flag: true,
    });
    const recs = generateInventoryRecommendations([row], "2026-05-15");
    expect(recs[0].recommendation_type).toBe("expedite");
  });

  it("excess with a planned PO → cancel_receipt", () => {
    const row = proj({
      beginning_on_hand_qty: 300, inbound_po_qty: 100,
      total_available_supply_qty: 400,
      wholesale_demand_qty: 50, ecom_demand_qty: 50,
      allocated_total_qty: 100,
      excess_qty: 300,
    });
    const recs = generateInventoryRecommendations([row], "2026-01-01");
    expect(recs[0].recommendation_type).toBe("cancel_receipt");
    expect(recs[0].recommendation_qty).toBe(100);
  });

  it("excess with no planned PO → reduce", () => {
    const row = proj({
      beginning_on_hand_qty: 400,
      total_available_supply_qty: 400,
      wholesale_demand_qty: 50, ecom_demand_qty: 50,
      allocated_total_qty: 100, excess_qty: 300,
    });
    const recs = generateInventoryRecommendations([row], "2026-01-01");
    expect(recs[0].recommendation_type).toBe("reduce");
  });

  it("balanced → hold", () => {
    const row = proj({
      total_available_supply_qty: 100,
      wholesale_demand_qty: 50, ecom_demand_qty: 50,
      allocated_total_qty: 100,
    });
    const recs = generateInventoryRecommendations([row], "2026-01-01");
    expect(recs[0].recommendation_type).toBe("hold");
  });

  it("protected ecom shortfall → protect_inventory recommendation", () => {
    const row = proj({
      total_available_supply_qty: 10, ecom_demand_qty: 50, protected_ecom_qty: 30,
      allocated_ecom_qty: 10, allocated_total_qty: 10, shortage_qty: 40, projected_stockout_flag: true,
    });
    const recs = generateInventoryRecommendations([row], "2026-01-01", {
      protectedShortfall: new Map([[`${row.sku_id}:${row.period_start}`, 20]]),
    });
    expect(recs.some((r) => r.recommendation_type === "protect_inventory")).toBe(true);
  });

  it("reserve shortfall → reallocate recommendation", () => {
    const row = proj({
      total_available_supply_qty: 10, wholesale_demand_qty: 50,
      reserved_wholesale_qty: 30, allocated_wholesale_qty: 10,
      allocated_total_qty: 10, shortage_qty: 40, projected_stockout_flag: true,
    });
    const recs = generateInventoryRecommendations([row], "2026-01-01", {
      reserveShortfall: new Map([[`${row.sku_id}:${row.period_start}`, 20]]),
    });
    expect(recs.some((r) => r.recommendation_type === "reallocate")).toBe(true);
  });
});

describe("generateSupplyExceptions", () => {
  it("stockout produces a critical exception when shortage ≥ 25% of demand", () => {
    const row = proj({
      total_available_supply_qty: 60,
      wholesale_demand_qty: 80, ecom_demand_qty: 40,
      shortage_qty: 60, projected_stockout_flag: true,
    });
    const exc = generateSupplyExceptions([row]);
    const stockout = exc.find((e) => e.exception_type === "projected_stockout");
    expect(stockout?.severity).toBe("critical");
  });

  it("negative ATS produces an exception", () => {
    const row = proj({ ats_qty: -5, wholesale_demand_qty: 10 });
    const exc = generateSupplyExceptions([row]);
    expect(exc.some((e) => e.exception_type === "negative_ats")).toBe(true);
  });

  it("missing supply inputs when every bucket is 0 and demand > 0", () => {
    const row = proj({ wholesale_demand_qty: 10 });
    const exc = generateSupplyExceptions([row]);
    expect(exc.some((e) => e.exception_type === "missing_supply_inputs")).toBe(true);
  });

  it("late_po exception when PO lands after period_end and row is short", () => {
    const row = proj({
      shortage_qty: 10, projected_stockout_flag: true,
      total_available_supply_qty: 0, wholesale_demand_qty: 10,
    });
    const exc = generateSupplyExceptions([row], {
      poByGrain: new Map([[`${row.sku_id}:${row.period_start}`, [
        { po_number: "PO-1", expected_date: "2026-07-10", qty_open: 10 },
      ]]]),
    });
    expect(exc.some((e) => e.exception_type === "late_po")).toBe(true);
  });

  it("excess_inventory exception produced when excess ≥ 30% of demand", () => {
    const row = proj({
      total_available_supply_qty: 200,
      wholesale_demand_qty: 50, ecom_demand_qty: 50,
      excess_qty: 100,
    });
    const exc = generateSupplyExceptions([row]);
    expect(exc.some((e) => e.exception_type === "excess_inventory")).toBe(true);
  });

  it("protected_not_covered exception when context says so", () => {
    const row = proj({ ecom_demand_qty: 50, protected_ecom_qty: 40 });
    const exc = generateSupplyExceptions([row], {
      protectedShortfall: new Map([[`${row.sku_id}:${row.period_start}`, 20]]),
    });
    expect(exc.some((e) => e.exception_type === "protected_not_covered")).toBe(true);
  });
});
