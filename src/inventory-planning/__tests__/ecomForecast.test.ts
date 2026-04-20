import { describe, it, expect } from "vitest";
import {
  buildEcomBaselineForecast,
  applyOverrides,
  buildFinalEcomForecast,
  applyPromoAdjustments,
  applyLaunchCurve,
  applyReturnAdjustment,
  applyMarkdown,
  LAUNCH_CURVE,
  PROMO_UPLIFT_DEFAULT,
  RETURN_RATE_CAP,
} from "../ecom/compute/ecomForecast";
import type { IpEcomForecastComputeInput } from "../ecom/types/ecom";

const RUN = "run-ecom";
const CHAN = "chan-shopify-us";
const SKU = "sku-abc";
const CAT = "cat-tops";

function h(channel: string, sku: string, date: string, qty: number, returned = 0, category: string | null = CAT) {
  return { channel_id: channel, sku_id: sku, category_id: category, order_date: date, qty, returned_qty: returned };
}

const SNAPSHOT = "2026-04-30";  // Thursday
const HORIZON_START = "2026-05-04"; // Monday of W19
const HORIZON_END = "2026-05-31";

const baseInput = (overrides: Partial<IpEcomForecastComputeInput> = {}): IpEcomForecastComputeInput => ({
  planning_run_id: RUN,
  source_snapshot_date: SNAPSHOT,
  horizon_start: HORIZON_START,
  horizon_end: HORIZON_END,
  triples: [{ channel_id: CHAN, sku_id: SKU, category_id: CAT, launch_date: null, markdown_flag: false, is_active: true }],
  history: [],
  overrides: [],
  ...overrides,
});

// ── factor unit tests ─────────────────────────────────────────────────────
describe("factor functions", () => {
  it("promo default uplift", () => {
    expect(applyPromoAdjustments(100, true)).toBe(100 * PROMO_UPLIFT_DEFAULT);
    expect(applyPromoAdjustments(100, false)).toBe(100);
  });
  it("launch curve", () => {
    expect(applyLaunchCurve(0)).toBe(LAUNCH_CURVE[0]);
    expect(applyLaunchCurve(5)).toBe(LAUNCH_CURVE[5]);
    expect(applyLaunchCurve(99)).toBe(1.0);
  });
  it("return adjustment is clamped at RETURN_RATE_CAP", () => {
    expect(applyReturnAdjustment(100, 0.1)).toBe(90);
    expect(applyReturnAdjustment(100, 0.9)).toBe(100 * (1 - RETURN_RATE_CAP));
    expect(applyReturnAdjustment(100, -0.1)).toBe(100);
  });
  it("markdown uplift decays after first 2 weeks", () => {
    expect(applyMarkdown(100, 0)).toBeGreaterThan(applyMarkdown(100, 3));
  });
});

// ── zero-history SKU ──────────────────────────────────────────────────────
describe("zero-history SKU", () => {
  it("produces zero_floor forecast rows without crashing", () => {
    const rows = buildEcomBaselineForecast(baseInput());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.system_forecast_qty === 0)).toBe(true);
    expect(rows.every((r) => r.forecast_method === "zero_floor" || r.forecast_method === "seasonality")).toBe(true);
    expect(rows.every((r) => r.final_forecast_qty >= 0)).toBe(true);
  });
});

// ── launch scenario ───────────────────────────────────────────────────────
describe("launch scenario", () => {
  it("rides the launch curve using the planner baseline when no history", () => {
    const rows = buildEcomBaselineForecast(baseInput({
      triples: [{
        channel_id: CHAN, sku_id: SKU, category_id: CAT,
        launch_date: HORIZON_START, markdown_flag: false, is_active: true,
      }],
    }));
    // First forecast week should be flagged launch and use the curve.
    expect(rows[0].launch_flag).toBe(true);
    expect(rows[0].forecast_method).toBe("launch_curve");
    expect(rows[0].system_forecast_qty).toBeGreaterThan(0);
    expect(rows[0].launch_factor).toBeGreaterThan(0);
    expect(rows[0].launch_factor).toBeLessThanOrEqual(1);
  });
});

// ── promo uplift ──────────────────────────────────────────────────────────
describe("promo uplift", () => {
  it("uplifts system forecast on promo weeks", () => {
    // 13 weeks of 50 units each → rr13 = 50
    const weeks: Array<{ date: string; qty: number }> = [];
    for (let i = 1; i <= 13; i++) {
      const d = new Date("2026-04-27T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 7 * i);
      weeks.push({ date: d.toISOString().slice(0, 10), qty: 50 });
    }
    const history = weeks.map((w) => h(CHAN, SKU, w.date, w.qty));
    const baseline = buildEcomBaselineForecast(baseInput({ history }));
    const withPromo = buildEcomBaselineForecast(baseInput({
      history,
      promos: [{ channel_id: CHAN, sku_id: SKU, start: HORIZON_START, end: HORIZON_END }],
    }));
    // Promo rows should all be larger than baseline on the same week_code.
    for (let i = 0; i < baseline.length; i++) {
      expect(withPromo[i].system_forecast_qty).toBeGreaterThan(baseline[i].system_forecast_qty);
      expect(withPromo[i].promo_flag).toBe(true);
    }
  });
});

// ── markdown scenario ─────────────────────────────────────────────────────
describe("markdown scenario", () => {
  it("applies decay uplift to baseline forecast", () => {
    const weeks: string[] = [];
    for (let i = 1; i <= 13; i++) {
      const d = new Date("2026-04-27T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 7 * i);
      weeks.push(d.toISOString().slice(0, 10));
    }
    const history = weeks.map((w) => h(CHAN, SKU, w, 50));
    const normal = buildEcomBaselineForecast(baseInput({ history }));
    const markdown = buildEcomBaselineForecast(baseInput({
      history,
      triples: [{ channel_id: CHAN, sku_id: SKU, category_id: CAT, launch_date: null, markdown_flag: true, is_active: true }],
    }));
    expect(markdown[0].system_forecast_qty).toBeGreaterThan(normal[0].system_forecast_qty);
    expect(markdown[0].markdown_flag).toBe(true);
  });
});

// ── high return-rate SKU ──────────────────────────────────────────────────
describe("high return-rate SKU", () => {
  it("deflates system forecast and records return rate", () => {
    const weeks: string[] = [];
    for (let i = 1; i <= 13; i++) {
      const d = new Date("2026-04-27T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 7 * i);
      weeks.push(d.toISOString().slice(0, 10));
    }
    // 50 units shipped, 15 returned each week → 30% return rate
    const history = weeks.map((w) => h(CHAN, SKU, w, 50, 15));
    const rows = buildEcomBaselineForecast(baseInput({ history }));
    expect(rows[0].return_rate).toBeCloseTo(0.3, 1);
    // Without returns we'd forecast ~50; with 30% returns we'd forecast ~35.
    expect(rows[0].system_forecast_qty).toBeGreaterThan(30);
    expect(rows[0].system_forecast_qty).toBeLessThan(42);
  });
});

// ── override + protected demand ───────────────────────────────────────────
describe("overrides", () => {
  it("add to system, floor at 0, and track protected_ecom_qty", () => {
    const rows = buildEcomBaselineForecast(baseInput());
    const ov = applyOverrides(rows, [{
      channel_id: CHAN, sku_id: SKU, week_start: rows[0].week_start, override_qty: 25,
    }]);
    expect(ov[0].override_qty).toBe(25);
    expect(ov[0].final_forecast_qty).toBe(Math.max(0, rows[0].system_forecast_qty + 25));
    expect(ov[0].protected_ecom_qty).toBe(ov[0].final_forecast_qty);
  });
  it("negative override floors at zero", () => {
    const rows = buildEcomBaselineForecast(baseInput());
    const ov = applyOverrides(rows, [{
      channel_id: CHAN, sku_id: SKU, week_start: rows[0].week_start, override_qty: -9999,
    }]);
    expect(ov[0].final_forecast_qty).toBe(0);
    expect(ov[0].protected_ecom_qty).toBe(0);
  });
});

// ── forecast stability (no NaNs / negatives anywhere) ─────────────────────
describe("forecast stability", () => {
  it("never emits NaN or negative qty across a wide input", () => {
    const weeks: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const d = new Date("2026-04-27T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 7 * i);
      weeks.push(d.toISOString().slice(0, 10));
    }
    const history = [
      ...weeks.slice(0, 5).map((w) => h(CHAN, SKU, w, 0, 0)),     // zero weeks
      ...weeks.slice(5, 10).map((w) => h(CHAN, SKU, w, 1000, 900)), // impossible-high returns
      ...weeks.slice(10).map((w) => h(CHAN, SKU, w, 5, 0)),       // trickle
    ];
    const rows = buildFinalEcomForecast(baseInput({
      history,
      triples: [{ channel_id: CHAN, sku_id: SKU, category_id: CAT, launch_date: null, markdown_flag: true, is_active: true }],
      promos: [{ channel_id: CHAN, sku_id: SKU, start: HORIZON_START, end: HORIZON_END }],
      overrides: [{ channel_id: CHAN, sku_id: SKU, week_start: HORIZON_START, override_qty: -50 }],
    }));
    for (const r of rows) {
      expect(Number.isFinite(r.system_forecast_qty)).toBe(true);
      expect(r.system_forecast_qty).toBeGreaterThanOrEqual(0);
      expect(r.final_forecast_qty).toBeGreaterThanOrEqual(0);
      expect(r.protected_ecom_qty).toBeGreaterThanOrEqual(0);
    }
  });
});
