import { describe, it, expect } from "vitest";
import { recommendForRow, DEFAULT_THRESHOLDS } from "../compute/recommendations";
import type { PeriodSupply } from "../compute/supply";

const supply = (partial: Partial<PeriodSupply> = {}): PeriodSupply => ({
  on_hand_qty: 0, on_po_qty: 0, receipts_due_qty: 0, available_supply_qty: 0, ...partial,
});

const row = (partial: Partial<{ final_forecast_qty: number; period_start: string; period_end: string }>) => ({
  final_forecast_qty: 100,
  period_start: "2026-06-01",
  period_end: "2026-06-30",
  ...partial,
});

const ASOF = "2026-04-19";
const FAR_ASOF = "2026-01-01";

describe("recommendForRow", () => {
  it("supply lower than final → buy with qty = shortage", () => {
    const r = recommendForRow(row({}), supply({ available_supply_qty: 70 }), FAR_ASOF);
    expect(r.recommended_action).toBe("buy");
    expect(r.recommended_qty).toBe(30);
    expect(r.projected_shortage_qty).toBe(30);
  });

  it("shortage within expedite window → expedite", () => {
    // Period starts 2026-06-01 and asOf 2026-05-15 → 17 days → < 30 → expedite
    const r = recommendForRow(row({}), supply({ available_supply_qty: 70 }), "2026-05-15");
    expect(r.recommended_action).toBe("expedite");
  });

  it("tiny forecast below monitor floor → monitor", () => {
    const r = recommendForRow(row({ final_forecast_qty: 3 }), supply({ available_supply_qty: 0 }), ASOF);
    expect(r.recommended_action).toBe("monitor");
  });

  it("supply much higher than final → reduce with excess qty", () => {
    const r = recommendForRow(row({}), supply({ available_supply_qty: 400 }), ASOF);
    expect(r.recommended_action).toBe("reduce");
    expect(r.recommended_qty).toBe(300);
  });

  it("supply within 10% tolerance → hold", () => {
    const r = recommendForRow(row({}), supply({ available_supply_qty: 95 }), ASOF);
    expect(r.recommended_action).toBe("hold");
  });

  it("zero forecast and zero supply → hold", () => {
    const r = recommendForRow(row({ final_forecast_qty: 0 }), supply(), ASOF);
    expect(r.recommended_action).toBe("hold");
  });

  it("past period → monitor", () => {
    const r = recommendForRow(
      row({ period_start: "2026-01-01", period_end: "2026-01-31" }),
      supply({ available_supply_qty: 0 }),
      "2026-04-01",
    );
    expect(r.recommended_action).toBe("monitor");
  });

  it("respects custom thresholds", () => {
    const r = recommendForRow(row({}), supply({ available_supply_qty: 94 }), ASOF, {
      ...DEFAULT_THRESHOLDS,
      shortagePct: 0.05,
    });
    // 6 units shortage > 5% of 100 → buy
    expect(r.recommended_action).toBe("buy");
  });

  describe("MOQ rounding", () => {
    it("rounds shortage up to the nearest MOQ multiple", () => {
      // shortage = 87, MOQ = 144 → rec_qty = 144
      const r = recommendForRow(
        row({ final_forecast_qty: 100 }),
        supply({ available_supply_qty: 13 }),
        FAR_ASOF,
        DEFAULT_THRESHOLDS,
        144,
      );
      expect(r.recommended_action).toBe("buy");
      expect(r.recommended_qty).toBe(144);
      expect(r.projected_shortage_qty).toBe(87); // gap stays unrounded
      expect(r.action_reason).toContain("MOQ 144");
    });

    it("leaves recommended_qty unchanged when shortage is already a clean MOQ multiple", () => {
      // shortage = 144 (exactly), MOQ = 144 → rec_qty = 144, no MOQ note
      const r = recommendForRow(
        row({ final_forecast_qty: 200 }),
        supply({ available_supply_qty: 56 }),
        FAR_ASOF,
        DEFAULT_THRESHOLDS,
        144,
      );
      expect(r.recommended_qty).toBe(144);
      expect(r.action_reason).not.toContain("MOQ");
    });

    it("ignores MOQ ≤ 1 (no constraint)", () => {
      const r = recommendForRow(
        row({ final_forecast_qty: 100 }),
        supply({ available_supply_qty: 13 }),
        FAR_ASOF,
        DEFAULT_THRESHOLDS,
        1,
      );
      expect(r.recommended_qty).toBe(87);
    });

    it("rounds expedite shortages to MOQ as well", () => {
      const r = recommendForRow(
        row({}),
        supply({ available_supply_qty: 70 }),
        "2026-05-15",
        DEFAULT_THRESHOLDS,
        50,
      );
      expect(r.recommended_action).toBe("expedite");
      expect(r.recommended_qty).toBe(50); // shortage 30 rounded to 50
    });
  });
});
