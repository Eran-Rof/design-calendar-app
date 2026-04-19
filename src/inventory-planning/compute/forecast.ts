// Wholesale baseline forecast. Explicitly dumb — no ML, no regression,
// no exponential smoothing. A planner should be able to read this file
// and reproduce any single number on paper.
//
// ── The stack (applied in order; first hit wins) ────────────────────────────
//
//   1. SKU trailing average (trailing_avg_sku)
//      — At least 3 months of non-zero history on the (customer, sku) pair
//        in the last 12 months. Baseline = mean of those months, rounded
//        to whole units.
//
//   2. SKU weighted recent (weighted_recent_sku)
//      — Used when we have 3+ months and the most recent 3 months sum is
//        at least 30% of the last-12 sum — i.e. the pair is still active.
//        Replaces (1) when it produces a larger-but-plausible number;
//        we pick max(avg, recent3/3) because wholesale is more often
//        rising than falling when a program is reordered.
//
//   3. SKU cadence (cadence_sku)
//      — Used when history is sparse (1–2 orders in 12 months) but the
//        last order is recent. We compute average qty per order × (1 / gap
//        between orders in months), floored to 0. This catches programs
//        that reorder every N months.
//
//   4. Category fallback (category_fallback)
//      — No qualifying pair history. Average of the last 6 months of
//        (customer, category) across all SKUs in that category, divided
//        by number of active SKUs for the customer in that category.
//
//   5. Customer/category global fallback (customer_category_fallback)
//      — Still nothing. Use the customer-level monthly average across
//        all categories, divided by the active SKU count for the pair's
//        category. Conservative by construction.
//
//   6. zero_floor
//      — Nothing matched. Emit 0 and mark confidence='estimate'.
//
// Confidence levels come from the method plus the buyer-request overlay:
//   committed : buyer request with confidence='committed' touches the period
//   probable  : buyer request with confidence='probable', OR SKU history
//               with >=6 non-zero months in the last 12
//   possible  : SKU cadence or SKU average on 3–5 months of history
//   estimate  : everything else (fallbacks, zero floor)
//
// ── Final forecast (authoritative formula) ─────────────────────────────────
//
//   final = max(0, system + buyer_request + override)
//
// Override is an additive signed delta, NOT a replacement — so the three
// sources remain independently auditable. To "set final to 100" when the
// system says 70, a planner enters an override of +30. Documented in the
// Phase 1 README.

import type { IpIsoDate } from "../types/entities";
import type {
  IpConfidenceLevel,
  IpForecastComputeInput,
  IpForecastComputeOutput,
  IpForecastMethod,
} from "../types/wholesale";
import { monthOf, monthOffset, monthsBetween, monthsDiff } from "./periods";

// ── helpers ────────────────────────────────────────────────────────────────
function round(n: number): number {
  // Wholesale quantities are generally integers; we hold numeric in the
  // DB but round at the edge so the UI isn't full of .333.
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function sum(xs: number[]): number { return xs.reduce((a, b) => a + b, 0); }

function bucketHistoryByMonth(
  history: IpForecastComputeInput["history"],
  customerId: string,
  skuId: string,
  months: string[], // "YYYY-MM" codes
): Map<string, number> {
  const out = new Map<string, number>(months.map((m) => [m, 0]));
  for (const row of history) {
    if (row.customer_id !== customerId) continue;
    if (row.sku_id !== skuId) continue;
    const code = monthOf(row.txn_date).period_code;
    if (!out.has(code)) continue;
    out.set(code, (out.get(code) ?? 0) + row.qty);
  }
  return out;
}

// Returns the last-12-month window (as "YYYY-MM" codes) ending in the
// month of snapshotIso.
function lookbackMonthCodes(snapshotIso: IpIsoDate, months = 12): string[] {
  const codes: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    codes.push(monthOffset(snapshotIso, i).period_code);
  }
  return codes;
}

// ── per-pair baseline ──────────────────────────────────────────────────────
interface PairBaselineResult {
  qty: number;
  method: IpForecastMethod;
  confidence: IpConfidenceLevel;
  history_months_used: number | null;
}

function baselineForPair(
  input: IpForecastComputeInput,
  customerId: string,
  skuId: string,
  categoryId: string | null,
): PairBaselineResult {
  const lookback = lookbackMonthCodes(input.source_snapshot_date, 12);
  const bucket = bucketHistoryByMonth(input.history, customerId, skuId, lookback);
  const monthly = lookback.map((m) => bucket.get(m) ?? 0);
  const nonZeroMonths = monthly.filter((v) => v > 0).length;
  const last12Sum = sum(monthly);
  const last3Sum = sum(monthly.slice(-3));

  // (1)+(2): active SKU history.
  if (nonZeroMonths >= 3 && last12Sum > 0) {
    const avg = last12Sum / 12;
    const recent = last3Sum / 3;
    // Pick the higher of the two when recent is at least 30% of the
    // 12-month total — treats "currently active" programs as worth leaning
    // into. Otherwise fall back to plain average.
    const weighted = last3Sum >= 0.3 * last12Sum && recent > avg;
    return {
      qty: round(weighted ? recent : avg),
      method: weighted ? "weighted_recent_sku" : "trailing_avg_sku",
      confidence: nonZeroMonths >= 6 ? "probable" : "possible",
      history_months_used: 12,
    };
  }

  // (3): SKU cadence.
  if (nonZeroMonths >= 1 && last12Sum > 0) {
    const firstIdx = monthly.findIndex((v) => v > 0);
    const lastIdx = monthly.length - 1 - [...monthly].reverse().findIndex((v) => v > 0);
    const orderQty = last12Sum / nonZeroMonths;
    // Cadence expressed as average months between orders. If only one
    // non-zero month is visible, assume the next order is one cadence
    // later — conservative — and use the full month qty.
    const span = lastIdx - firstIdx; // inclusive span in months
    const cadenceMonths = nonZeroMonths > 1 ? Math.max(1, Math.round(span / (nonZeroMonths - 1))) : 12;
    return {
      qty: round(orderQty / cadenceMonths),
      method: "cadence_sku",
      confidence: "possible",
      history_months_used: 12,
    };
  }

  // (4): customer/category fallback.
  if (categoryId) {
    const months6 = lookbackMonthCodes(input.source_snapshot_date, 6);
    const catSku = new Set<string>();
    let catSum = 0;
    for (const row of input.history) {
      if (row.customer_id !== customerId) continue;
      if (row.category_id !== categoryId) continue;
      const code = monthOf(row.txn_date).period_code;
      if (!months6.includes(code)) continue;
      catSum += row.qty;
      catSku.add(row.sku_id);
    }
    if (catSum > 0) {
      const skuCount = Math.max(catSku.size, 1);
      return {
        qty: round(catSum / 6 / skuCount),
        method: "category_fallback",
        confidence: "estimate",
        history_months_used: 6,
      };
    }
  }

  // (5): customer-wide fallback.
  const months3 = lookbackMonthCodes(input.source_snapshot_date, 3);
  let custSum = 0;
  const custSkuByCat = new Map<string | null, Set<string>>();
  for (const row of input.history) {
    if (row.customer_id !== customerId) continue;
    const code = monthOf(row.txn_date).period_code;
    if (!months3.includes(code)) continue;
    custSum += row.qty;
    const key = row.category_id ?? null;
    const set = custSkuByCat.get(key) ?? new Set<string>();
    set.add(row.sku_id);
    custSkuByCat.set(key, set);
  }
  if (custSum > 0) {
    const inferredSkus = (custSkuByCat.get(categoryId) ?? new Set<string>()).size ||
                          [...custSkuByCat.values()].reduce((a, s) => a + s.size, 0) ||
                          1;
    return {
      qty: round(custSum / 3 / inferredSkus),
      method: "customer_category_fallback",
      confidence: "estimate",
      history_months_used: 3,
    };
  }

  // (6): zero floor.
  return { qty: 0, method: "zero_floor", confidence: "estimate", history_months_used: null };
}

// ── public API ─────────────────────────────────────────────────────────────
export function buildWholesaleBaselineForecast(
  input: IpForecastComputeInput,
): IpForecastComputeOutput[] {
  const horizon = monthsBetween(input.horizon_start, input.horizon_end);
  if (horizon.length === 0) return [];

  // Cache baselines per pair — the baseline is horizon-independent in MVP
  // (we assign the same qty to every month of the horizon). A seasonality
  // layer is Phase 2 territory.
  const baselineCache = new Map<string, PairBaselineResult>();
  const out: IpForecastComputeOutput[] = [];

  for (const pair of input.pairs) {
    const key = `${pair.customer_id}:${pair.sku_id}`;
    let baseline = baselineCache.get(key);
    if (!baseline) {
      baseline = baselineForPair(input, pair.customer_id, pair.sku_id, pair.category_id);
      baselineCache.set(key, baseline);
    }

    for (const period of horizon) {
      out.push({
        planning_run_id: input.planning_run_id,
        customer_id: pair.customer_id,
        category_id: pair.category_id,
        sku_id: pair.sku_id,
        period_start: period.period_start,
        period_end: period.period_end,
        period_code: period.period_code,
        system_forecast_qty: baseline.qty,
        buyer_request_qty: 0,
        override_qty: 0,
        final_forecast_qty: baseline.qty,
        confidence_level: baseline.confidence,
        forecast_method: baseline.method,
        history_months_used: baseline.history_months_used,
        notes: null,
      });
    }
  }
  return out;
}

export function applyBuyerRequests(
  rows: IpForecastComputeOutput[],
  requests: IpForecastComputeInput["requests"],
): IpForecastComputeOutput[] {
  if (requests.length === 0) return rows;
  // Index requests by grain for O(1) lookup.
  const idx = new Map<string, { qty: number; confidence: IpConfidenceLevel }>();
  for (const r of requests) {
    const key = `${r.customer_id}:${r.sku_id}:${r.period_start}`;
    const prev = idx.get(key);
    // Sum multiple requests on the same grain; confidence picks the strongest.
    idx.set(key, {
      qty: (prev?.qty ?? 0) + r.requested_qty,
      confidence: strongerConfidence(prev?.confidence ?? "estimate", r.confidence_level),
    });
  }

  // Track which request keys matched an existing baseline row; any that
  // didn't become synthetic rows so a buyer request without history still
  // appears on the grid. Those carry system_forecast_qty = 0 and
  // forecast_method = 'zero_floor'.
  const matched = new Set<string>();
  const updated = rows.map((row) => {
    const key = `${row.customer_id}:${row.sku_id}:${row.period_start}`;
    const req = idx.get(key);
    if (!req) return row;
    matched.add(key);
    return {
      ...row,
      buyer_request_qty: req.qty,
      confidence_level: strongerConfidence(row.confidence_level, req.confidence),
      final_forecast_qty: Math.max(0, row.system_forecast_qty + req.qty + row.override_qty),
    };
  });

  const synthetic: IpForecastComputeOutput[] = [];
  for (const r of requests) {
    const key = `${r.customer_id}:${r.sku_id}:${r.period_start}`;
    if (matched.has(key)) continue;
    const period = monthOf(r.period_start);
    const sample = rows.find((row) => row.customer_id === r.customer_id && row.sku_id === r.sku_id);
    synthetic.push({
      planning_run_id: sample?.planning_run_id ?? rows[0]?.planning_run_id ?? "",
      customer_id: r.customer_id,
      category_id: sample?.category_id ?? null,
      sku_id: r.sku_id,
      period_start: period.period_start,
      period_end: period.period_end,
      period_code: period.period_code,
      system_forecast_qty: 0,
      buyer_request_qty: idx.get(key)?.qty ?? r.requested_qty,
      override_qty: 0,
      final_forecast_qty: Math.max(0, idx.get(key)?.qty ?? r.requested_qty),
      confidence_level: r.confidence_level,
      forecast_method: "zero_floor",
      history_months_used: null,
      notes: "Synthesized from buyer request — no prior history.",
    });
    matched.add(key); // avoid double-appending if multiple requests share a key
  }
  return [...updated, ...synthetic];
}

export function applyPlannerOverrides(
  rows: IpForecastComputeOutput[],
  overrides: IpForecastComputeInput["overrides"],
): IpForecastComputeOutput[] {
  if (overrides.length === 0) return rows;
  const idx = new Map<string, number>();
  for (const o of overrides) {
    const key = `${o.customer_id}:${o.sku_id}:${o.period_start}`;
    // Most recent write wins — the caller is expected to pass the latest
    // override per grain (the repository helper does this).
    idx.set(key, o.override_qty);
  }
  return rows.map((row) => {
    const key = `${row.customer_id}:${row.sku_id}:${row.period_start}`;
    const override = idx.get(key);
    if (override == null) return row;
    return {
      ...row,
      override_qty: override,
      final_forecast_qty: Math.max(0, row.system_forecast_qty + row.buyer_request_qty + override),
    };
  });
}

export function buildFinalWholesaleForecast(
  input: IpForecastComputeInput,
): IpForecastComputeOutput[] {
  const baseline = buildWholesaleBaselineForecast(input);
  const withRequests = applyBuyerRequests(baseline, input.requests);
  const finalRows = applyPlannerOverrides(withRequests, input.overrides);
  return finalRows;
}

// ── internal ───────────────────────────────────────────────────────────────
function confidenceRank(c: IpConfidenceLevel): number {
  switch (c) {
    case "committed": return 4;
    case "probable":  return 3;
    case "possible":  return 2;
    case "estimate":  return 1;
  }
}

function strongerConfidence(a: IpConfidenceLevel, b: IpConfidenceLevel): IpConfidenceLevel {
  return confidenceRank(a) >= confidenceRank(b) ? a : b;
}

// Exported so tests / the admin drawer can display why a number came out
// the way it did without duplicating the logic.
export const __forecastInternals = {
  baselineForPair,
  lookbackMonthCodes,
  bucketHistoryByMonth,
  confidenceRank,
  strongerConfidence,
  monthsDiff, // re-export for consumers wanting cadence info
};
