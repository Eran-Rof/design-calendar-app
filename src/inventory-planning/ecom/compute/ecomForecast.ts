// Ecom baseline forecast. Explicit multi-factor stack — no ML, no
// hidden state. Each factor is a pure function that takes numbers and
// a week context and returns numbers. Compose them with buildFinalEcomForecast.
//
// ── The stack (per (channel, sku, week), applied left to right) ────────────
//
//   system_forecast_qty =
//     baselineGrossQty                                             -- step 1
//       × seasonality_factor                                       -- step 2
//       × promo_factor (if a promo window covers the week)         -- step 3
//       × launch_factor (if inside launch curve window)            -- step 4
//       × markdown_factor (if markdown_flag on the channel_status) -- step 5
//       × (1 − return_rate)  -- "net demand" — what ships minus    -- step 6
//                              expected returns. Capped at 0.6 so
//                              an extreme seasonal spike in returns
//                              doesn't collapse the number.
//
//   final_forecast_qty = max(0, system_forecast_qty + override_qty)
//
//   protected_ecom_qty = final_forecast_qty   (MVP: full protection —
//                       Phase 3 allocation layer tunes this by policy.)
//
// ── Baseline (step 1) ─────────────────────────────────────────────────────
//
//   • If 13+ weeks of history AND >=4 non-zero weeks in last 13:
//       rr4  = sum(last4)  / 4
//       rr13 = sum(last13) / 13
//       picks max(rr4, rr13), capped below 2× rr13 so a one-week
//       spike doesn't dominate. Method = "weighted_recent" if rr4
//       wins, else "trailing_13w".
//   • If <13 weeks but >=4 weeks exist: method = "trailing_4w" using
//       sum(last4) / 4.
//   • If SKU is within its launch window (launch_date set and we're
//       ≤ LAUNCH_CURVE_WEEKS weeks post-launch), method = "launch_curve"
//       and the baseline is LAUNCH_BASELINE × launch_factor (planner
//       assumption; documented in the README).
//   • Else if category has recent history (last 4 weeks, same channel),
//       method = "category_fallback", baseline =
//       sum(cat_last4) / 4 / active_sku_count.
//   • Else zero_floor.
//
// All returned numbers are rounded to whole units at the edge.

import type { IpIsoDate } from "../../types/entities";
import { weekOf, weeksDiff, weeksBetween, weekOffset } from "../../compute/periods";
import type {
  IpEcomForecastComputeInput,
  IpEcomForecastComputeOutput,
  IpEcomForecastMethod,
} from "../types/ecom";

// ── tunables ───────────────────────────────────────────────────────────────
export const LAUNCH_CURVE_WEEKS = 8;
// 8-week launch curve, normalized so week 6 == 1.0. Below-1 values mean
// "ramping"; a value > 1.0 would mean the launch is stronger than the
// eventual steady-state (not used here). These are planner assumptions;
// tweak in one place.
export const LAUNCH_CURVE: number[] = [0.30, 0.55, 0.75, 0.90, 0.98, 1.00, 1.00, 1.00];
export const LAUNCH_BASELINE_UNITS = 12; // units per week at the level the curve multiplies by
export const PROMO_UPLIFT_DEFAULT = 1.6;
export const MARKDOWN_INITIAL_UPLIFT = 1.8;   // first 2 weeks on markdown
export const MARKDOWN_DECAY_UPLIFT = 1.2;     // thereafter
export const RETURN_RATE_CAP = 0.6;            // never assume >60% returns

// Seasonality: compare each week's share of the year (in the history) to
// the evenly-distributed share (1/52). A 5% over-index becomes a factor
// of 1.05. Requires ≥ 26 weeks of history for the pair, else factor = 1.0.
const SEASONALITY_MIN_HISTORY = 26;

// ── helpers ────────────────────────────────────────────────────────────────
function round(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}
function sum(xs: number[]): number { return xs.reduce((a, b) => a + b, 0); }

function bucketByWeek(
  history: IpEcomForecastComputeInput["history"],
  channelId: string,
  skuId: string,
  weekCodes: string[],
): { gross: Map<string, number>; returned: Map<string, number> } {
  const gross = new Map<string, number>(weekCodes.map((w) => [w, 0]));
  const returned = new Map<string, number>(weekCodes.map((w) => [w, 0]));
  for (const row of history) {
    if (row.channel_id !== channelId) continue;
    if (row.sku_id !== skuId) continue;
    const code = weekOf(row.order_date).period_code;
    if (!gross.has(code)) continue;
    gross.set(code, (gross.get(code) ?? 0) + row.qty);
    returned.set(code, (returned.get(code) ?? 0) + row.returned_qty);
  }
  return { gross, returned };
}

// Return rate = returns / gross over the lookback. Clamped [0, RETURN_RATE_CAP].
function returnRateFor(
  history: IpEcomForecastComputeInput["history"],
  channelId: string,
  skuId: string,
): number {
  let g = 0;
  let r = 0;
  for (const row of history) {
    if (row.channel_id !== channelId) continue;
    if (row.sku_id !== skuId) continue;
    g += row.qty;
    r += row.returned_qty;
  }
  if (g <= 0) return 0;
  const rate = r / g;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.min(rate, RETURN_RATE_CAP);
}

// ── factor functions (exported for unit testing) ──────────────────────────
export function applySeasonality(base: number, factor: number): number {
  return base * factor;
}
export function applyPromoAdjustments(base: number, isPromoWeek: boolean, uplift = PROMO_UPLIFT_DEFAULT): number {
  return isPromoWeek ? base * uplift : base;
}
export function applyLaunchCurve(weeksSinceLaunch: number): number {
  // Returns the multiplier used in place of a baseline for a launching SKU.
  // Outside the curve window we return 1.0 (no adjustment — caller should
  // not flag launch_flag in that case).
  if (weeksSinceLaunch < 0) return 0;
  if (weeksSinceLaunch >= LAUNCH_CURVE.length) return 1.0;
  return LAUNCH_CURVE[weeksSinceLaunch];
}
export function applyMarkdown(base: number, weeksOnMarkdown: number): number {
  if (weeksOnMarkdown < 0) return base;
  const factor = weeksOnMarkdown < 2 ? MARKDOWN_INITIAL_UPLIFT : MARKDOWN_DECAY_UPLIFT;
  return base * factor;
}
export function applyReturnAdjustment(base: number, returnRate: number): number {
  const clamped = Math.max(0, Math.min(returnRate, RETURN_RATE_CAP));
  return base * (1 - clamped);
}

// Seasonality factor per week code, derived from history. If too sparse,
// returns 1.0 for every week (no adjustment) — intentionally conservative.
function seasonalityFactorsFor(
  history: IpEcomForecastComputeInput["history"],
  channelId: string,
  skuId: string,
): Map<string, number> {
  const out = new Map<string, number>();
  // Bucket the whole history, then for each month-of-year index compute
  // a factor = (avg qty in that month-of-year) / (overall avg monthly qty).
  const monthlyTotals: number[] = new Array(12).fill(0);
  const monthlyWeeks: number[] = new Array(12).fill(0);
  let totalQty = 0;
  let totalWeeks = 0;
  for (const row of history) {
    if (row.channel_id !== channelId) continue;
    if (row.sku_id !== skuId) continue;
    const d = new Date(row.order_date + "T00:00:00Z");
    const m = d.getUTCMonth();
    monthlyTotals[m] += row.qty;
    // Each row is one shipped-date entry, not one week. We count distinct
    // weeks elsewhere; for the MoY factor we just need relative intensity.
  }
  totalQty = sum(monthlyTotals);
  // Require at least SEASONALITY_MIN_HISTORY weeks (roughly 26) worth of
  // history; approximate that by needing total qty > 0 across ≥ 6 months.
  const monthsWithData = monthlyTotals.filter((v) => v > 0).length;
  if (monthsWithData < 6 || totalQty === 0) return out;
  const avgMonth = totalQty / 12;
  const moyFactor = monthlyTotals.map((t) => (avgMonth > 0 ? (t || avgMonth) / avgMonth : 1));
  // Don't let the factor swing more than ±40% in MVP; that keeps bad
  // history from producing absurd numbers.
  const clamped = moyFactor.map((f) => Math.min(1.4, Math.max(0.6, f)));
  // Emit a factor per week code is the caller's job; here we just return
  // the MoY lookup as a map keyed by month number (as "Mxx").
  for (let m = 0; m < 12; m++) out.set(`M${String(m + 1).padStart(2, "0")}`, clamped[m]);
  void totalWeeks; void monthlyWeeks;
  return out;
}

function monthKeyOf(iso: IpIsoDate): string {
  return `M${iso.slice(5, 7)}`;
}

function promoHitsWeek(
  promos: IpEcomForecastComputeInput["promos"] | undefined,
  channelId: string,
  skuId: string,
  weekStart: IpIsoDate,
  weekEnd: IpIsoDate,
): { hit: boolean; uplift: number } {
  if (!promos || promos.length === 0) return { hit: false, uplift: PROMO_UPLIFT_DEFAULT };
  for (const p of promos) {
    if (p.channel_id !== channelId) continue;
    if (p.sku_id !== skuId) continue;
    if (p.end < weekStart || p.start > weekEnd) continue;
    return { hit: true, uplift: p.uplift ?? PROMO_UPLIFT_DEFAULT };
  }
  return { hit: false, uplift: PROMO_UPLIFT_DEFAULT };
}

// Weeks since launch given launch_date and the week_start we're forecasting.
// Negative if the week precedes launch. If launch_date is null, returns -Infinity.
function weeksSinceLaunch(launchDate: IpIsoDate | null, weekStart: IpIsoDate): number {
  if (!launchDate) return Number.NEGATIVE_INFINITY;
  return weeksDiff(launchDate, weekStart);
}

// ── baseline ───────────────────────────────────────────────────────────────
interface PerTripleBaseline {
  grossBase: number;
  method: IpEcomForecastMethod;
  trailing4w: number;
  trailing13w: number;
}

function baselineForTriple(
  input: IpEcomForecastComputeInput,
  channelId: string,
  skuId: string,
  categoryId: string | null,
): PerTripleBaseline {
  const lookback: string[] = [];
  for (let i = 12; i >= 0; i--) lookback.push(weekOffset(input.source_snapshot_date, i).period_code);
  const { gross } = bucketByWeek(input.history, channelId, skuId, lookback);
  const weekly = lookback.map((w) => gross.get(w) ?? 0);
  const nonZero = weekly.filter((v) => v > 0).length;
  const last4 = sum(weekly.slice(-4));
  const last13 = sum(weekly);
  const rr4 = last4 / 4;
  const rr13 = last13 / 13;

  if (last13 > 0 && nonZero >= 4) {
    const cappedRr4 = Math.min(rr4, rr13 * 2); // anti-spike
    const pick = Math.max(cappedRr4, rr13);
    return {
      grossBase: pick,
      method: pick > rr13 ? "weighted_recent" : "trailing_13w",
      trailing4w: last4,
      trailing13w: last13,
    };
  }
  if (last4 > 0) {
    return {
      grossBase: rr4,
      method: "trailing_4w",
      trailing4w: last4,
      trailing13w: last13,
    };
  }
  // category fallback
  if (categoryId) {
    let catSum = 0;
    const catSku = new Set<string>();
    const last4codes = new Set(lookback.slice(-4));
    for (const row of input.history) {
      if (row.channel_id !== channelId) continue;
      if (row.category_id !== categoryId) continue;
      const code = weekOf(row.order_date).period_code;
      if (!last4codes.has(code)) continue;
      catSum += row.qty;
      catSku.add(row.sku_id);
    }
    if (catSum > 0) {
      const skuCount = Math.max(catSku.size, 1);
      return {
        grossBase: catSum / 4 / skuCount,
        method: "category_fallback",
        trailing4w: 0,
        trailing13w: 0,
      };
    }
  }
  return { grossBase: 0, method: "zero_floor", trailing4w: last4, trailing13w: last13 };
}

// ── public API ─────────────────────────────────────────────────────────────
export function buildEcomBaselineForecast(
  input: IpEcomForecastComputeInput,
): IpEcomForecastComputeOutput[] {
  const horizon = weeksBetween(input.horizon_start, input.horizon_end);
  if (horizon.length === 0) return [];

  const out: IpEcomForecastComputeOutput[] = [];
  const baselineCache = new Map<string, PerTripleBaseline>();
  const seasonalityCache = new Map<string, Map<string, number>>();
  const returnRateCache = new Map<string, number>();

  for (const triple of input.triples) {
    const key = `${triple.channel_id}:${triple.sku_id}`;
    let baseline = baselineCache.get(key);
    if (!baseline) {
      baseline = baselineForTriple(input, triple.channel_id, triple.sku_id, triple.category_id);
      baselineCache.set(key, baseline);
    }
    let seasonality = seasonalityCache.get(key);
    if (!seasonality) {
      seasonality = seasonalityFactorsFor(input.history, triple.channel_id, triple.sku_id);
      seasonalityCache.set(key, seasonality);
    }
    let returnRate = returnRateCache.get(key);
    if (returnRate == null) {
      returnRate = returnRateFor(input.history, triple.channel_id, triple.sku_id);
      returnRateCache.set(key, returnRate);
    }

    for (const period of horizon) {
      // ── step 4: launch curve first so it can replace the baseline for
      //   brand-new SKUs where trailing-window math means nothing.
      const wsl = weeksSinceLaunch(triple.launch_date, period.week_start);
      let isLaunch = false;
      let launchFactor = 1.0;
      let base = baseline.grossBase;
      let method = baseline.method;

      if (triple.launch_date && wsl >= 0 && wsl < LAUNCH_CURVE_WEEKS) {
        isLaunch = true;
        launchFactor = applyLaunchCurve(wsl);
        // When we don't yet have trailing history, ride the curve with a
        // planner-assumed baseline; once real weeks exist, the trailing
        // baseline takes over and launch just scales it.
        if (base === 0) {
          base = LAUNCH_BASELINE_UNITS * launchFactor;
          method = "launch_curve";
        } else {
          base = base * launchFactor;
        }
      }

      // ── step 2: seasonality
      const moyKey = monthKeyOf(period.week_start);
      const seasonFactor = seasonality.get(moyKey) ?? 1.0;
      let adjusted = applySeasonality(base, seasonFactor);
      if (seasonFactor !== 1.0 && method === "zero_floor") method = "seasonality";

      // ── step 3: promo
      const promo = promoHitsWeek(input.promos, triple.channel_id, triple.sku_id, period.week_start, period.week_end);
      let promoFactor = 1.0;
      if (promo.hit) {
        promoFactor = promo.uplift;
        adjusted = applyPromoAdjustments(adjusted, true, promo.uplift);
      }

      // ── step 5: markdown
      let markdownFactor = 1.0;
      if (triple.markdown_flag) {
        // We don't know "weeks on markdown" exactly in MVP — treat it as
        // ongoing, use the decay uplift.
        markdownFactor = MARKDOWN_DECAY_UPLIFT;
        adjusted = applyMarkdown(adjusted, 2);
      }

      // ── step 6: return adjustment
      const afterReturns = applyReturnAdjustment(adjusted, returnRate);

      const system = round(afterReturns);
      const final = Math.max(0, system); // override applied later
      out.push({
        planning_run_id: input.planning_run_id,
        channel_id: triple.channel_id,
        category_id: triple.category_id,
        sku_id: triple.sku_id,
        week_start: period.week_start,
        week_end: period.week_end,
        period_code: period.period_code,
        system_forecast_qty: system,
        override_qty: 0,
        final_forecast_qty: final,
        protected_ecom_qty: final,
        promo_flag: promo.hit,
        launch_flag: isLaunch,
        markdown_flag: triple.markdown_flag,
        forecast_method: method,
        return_rate: returnRate,
        seasonality_factor: seasonFactor,
        promo_factor: promoFactor,
        launch_factor: launchFactor,
        markdown_factor: markdownFactor,
        trailing_4w_qty: baseline.trailing4w,
        trailing_13w_qty: baseline.trailing13w,
        notes: null,
      });
    }
  }
  return out;
}

export function applyOverrides(
  rows: IpEcomForecastComputeOutput[],
  overrides: IpEcomForecastComputeInput["overrides"],
): IpEcomForecastComputeOutput[] {
  if (overrides.length === 0) return rows;
  const idx = new Map<string, number>();
  for (const o of overrides) {
    idx.set(`${o.channel_id}:${o.sku_id}:${o.week_start}`, o.override_qty);
  }
  return rows.map((row) => {
    const ov = idx.get(`${row.channel_id}:${row.sku_id}:${row.week_start}`);
    if (ov == null) return row;
    const final = Math.max(0, row.system_forecast_qty + ov);
    return {
      ...row,
      override_qty: ov,
      final_forecast_qty: final,
      // MVP: protected demand tracks final_forecast_qty verbatim.
      protected_ecom_qty: final,
    };
  });
}

export function buildFinalEcomForecast(
  input: IpEcomForecastComputeInput,
): IpEcomForecastComputeOutput[] {
  const baseline = buildEcomBaselineForecast(input);
  return applyOverrides(baseline, input.overrides);
}

// Exported for tests — so regressions in a factor don't require going
// through the full build pipeline.
export const __ecomInternals = {
  baselineForTriple,
  returnRateFor,
  seasonalityFactorsFor,
  promoHitsWeek,
  weeksSinceLaunch,
};
