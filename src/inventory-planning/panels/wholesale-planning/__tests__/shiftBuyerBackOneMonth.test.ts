import { describe, it, expect } from "vitest";
import { planBuyerShiftBackOneMonth } from "../shiftBuyerBackOneMonth";
import type { IpPlanningGridRow } from "../../../types/wholesale";

// Minimal row factory — only the fields the planner reads.
function row(period: string, buyer: number, over: Partial<IpPlanningGridRow> = {}): IpPlanningGridRow {
  const [y, m] = period.split("-");
  const start = `${y}-${m}-01`;
  return {
    forecast_id: `tbd:${period}`,
    tbd_id: `id-${period}`,
    sku_code: "RYB0412PPK", sku_style: "RYB0412PPK", sku_color: "Black",
    customer_id: "supply", customer_name: "(Supply Only)",
    group_name: "SHORTS", sub_category_name: "CARGO SHORTS",
    period_start: start, period_end: `${y}-${m}-28`, period_code: period,
    buyer_request_qty: buyer,
    is_tbd: true, is_user_added: true,
    ...over,
  } as IpPlanningGridRow;
}

describe("planBuyerShiftBackOneMonth", () => {
  it("moves a single month's Buyer to the prior month (Apr 1200 → Mar), clearing Apr", () => {
    const rows = [
      row("2027-02", 0), row("2027-03", 0), row("2027-04", 1200), row("2027-05", 0),
    ];
    const ops = planBuyerShiftBackOneMonth(rows);
    const byPeriod = Object.fromEntries(ops.map((o) => [o.period_code, o.new_buyer]));
    expect(byPeriod["2027-03"]).toBe(1200); // Mar receives Apr's qty
    expect(byPeriod["2027-04"]).toBe(0);    // Apr cleared
    // Feb/May unchanged (already 0, no incoming) → no ops emitted
    expect(byPeriod["2027-02"]).toBeUndefined();
    expect(byPeriod["2027-05"]).toBeUndefined();
    // Mar op patches the existing Mar row.
    expect(ops.find((o) => o.period_code === "2027-03")?.existing_tbd_id).toBe("id-2027-03");
  });

  it("cascades a contiguous schedule back one month", () => {
    const rows = [
      row("2027-03", 0), row("2027-04", 1200), row("2027-05", 800), row("2027-06", 0),
    ];
    const ops = planBuyerShiftBackOneMonth(rows);
    const byPeriod = Object.fromEntries(ops.map((o) => [o.period_code, o.new_buyer]));
    expect(byPeriod["2027-03"]).toBe(1200); // ← Apr
    expect(byPeriod["2027-04"]).toBe(800);  // ← May
    expect(byPeriod["2027-05"]).toBe(0);    // May cleared (Jun was 0)
  });

  it("creates the prior-month row when the earliest month carries a qty", () => {
    const rows = [row("2026-12", 500), row("2027-01", 0)];
    const ops = planBuyerShiftBackOneMonth(rows);
    const nov = ops.find((o) => o.period_code === "2026-11");
    expect(nov).toBeDefined();
    expect(nov?.new_buyer).toBe(500);
    expect(nov?.existing_tbd_id).toBeUndefined(); // must be created
    expect(nov?.period_start).toBe("2026-11-01");
    // Dec cleared.
    expect(ops.find((o) => o.period_code === "2026-12")?.new_buyer).toBe(0);
  });

  it("keeps (style, color) groups independent", () => {
    const rows = [
      row("2027-04", 1200, { sku_color: "Black" }),
      row("2027-03", 0, { sku_color: "Black" }),
      row("2027-04", 300, { sku_color: "Espresso", forecast_id: "tbd:esp-04", tbd_id: "esp-04" }),
      row("2027-03", 0, { sku_color: "Espresso", forecast_id: "tbd:esp-03", tbd_id: "esp-03" }),
    ];
    const ops = planBuyerShiftBackOneMonth(rows);
    const black = ops.find((o) => o.color === "Black" && o.period_code === "2027-03");
    const esp = ops.find((o) => o.color === "Espresso" && o.period_code === "2027-03");
    expect(black?.new_buyer).toBe(1200);
    expect(esp?.new_buyer).toBe(300);
  });

  it("returns no ops when nothing has a Buyer qty", () => {
    expect(planBuyerShiftBackOneMonth([row("2027-04", 0), row("2027-05", 0)])).toEqual([]);
  });
});
