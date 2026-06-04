// Forecast Accuracy report.
//
// Scores a planning run's forecast vs actuals from ip_forecast_accuracy at a
// chosen grain. Reports volume-weighted MAPE (system & final) and bias so the
// final-vs-system columns show whether planner overrides helped.
//
//   MAPE  = Σ|forecast − actual| / Σ actual          (lower is better)
//   Bias  = Σ(forecast − actual) / Σ actual          (+ = over-forecast)
//
// Empty until a run has been scored on the Accuracy screen.

import type { ReportResult, ReportColumn } from "../types";
import type { RepAccuracy } from "../services/reportsRepository";
import { type LookupCtx, num, monthLabel, round1 } from "../lib/aggUtils";

export type AccGroupBy = "method" | "category" | "period" | "sku";

interface AccBucket {
  label: string;
  sysForecast: number; finalForecast: number; actual: number;
  absSys: number; absFinal: number;
  rows: number;
}

const METHOD_LABEL: Record<string, string> = {
  ly_sales: "Same Period LY",
  trailing_avg_sku: "Trailing Avg",
  weighted_recent_sku: "Weighted Recent",
  cadence_sku: "Cadence",
  category_fallback: "Category FB",
  customer_category_fallback: "Customer FB",
  zero_floor: "Zero Floor",
  trailing_4w: "Trailing 4w",
  trailing_13w: "Trailing 13w",
  seasonality: "Seasonality",
  launch_curve: "Launch Curve",
};

export function buildForecastAccuracy(rows: RepAccuracy[], ctx: LookupCtx, groupBy: AccGroupBy): ReportResult {
  const buckets = new Map<string, AccBucket>();

  const keyAndLabel = (r: RepAccuracy): { key: string; label: string } => {
    switch (groupBy) {
      case "method": { const m = r.forecast_method ?? ""; return { key: m, label: METHOD_LABEL[m] || m || "(none)" }; }
      case "category": { const id = r.category_id ?? ""; return { key: id, label: ctx.categoryName.get(id) || "(uncategorized)" }; }
      case "period": { const p = r.period_code ?? ""; return { key: p, label: monthLabel(p) }; }
      case "sku": { const id = r.sku_id ?? ""; const it = id ? ctx.itemById.get(id) : undefined; return { key: id, label: it?.sku_code || (id ? id.slice(0, 8) : "(none)") }; }
    }
  };

  for (const r of rows) {
    const { key, label } = keyAndLabel(r);
    let b = buckets.get(key);
    if (!b) { b = { label, sysForecast: 0, finalForecast: 0, actual: 0, absSys: 0, absFinal: 0, rows: 0 }; buckets.set(key, b); }
    const sys = num(r.system_forecast_qty), fin = num(r.final_forecast_qty), act = num(r.actual_qty);
    b.sysForecast += sys; b.finalForecast += fin; b.actual += act;
    // Prefer stored abs error; fall back to computing it.
    b.absSys += r.abs_error_system != null ? num(r.abs_error_system) : Math.abs(sys - act);
    b.absFinal += r.abs_error_final != null ? num(r.abs_error_final) : Math.abs(fin - act);
    b.rows++;
  }

  const list = [...buckets.values()].sort((a, z) => z.actual - a.actual);

  const dimHeader = { method: "Method", category: "Category", period: "Period", sku: "SKU" }[groupBy];
  const columns: ReportColumn[] = [
    { key: "dimension", header: dimHeader, align: "left" },
    { key: "actual", header: "Actual", format: "number", align: "right" },
    { key: "final_forecast", header: "Final Fcst", format: "number", align: "right" },
    { key: "system_forecast", header: "System Fcst", format: "number", align: "right" },
    { key: "mape_final", header: "MAPE Final %", format: "percent", align: "right" },
    { key: "mape_system", header: "MAPE System %", format: "percent", align: "right" },
    { key: "mape_delta", header: "Δ vs System", format: "percent", align: "right" },
    { key: "bias_final", header: "Bias Final %", format: "percent", align: "right" },
    { key: "lines", header: "Lines", format: "number", align: "right" },
  ];

  const rows2 = list.map((b) => {
    const mapeFinal = b.actual ? round1((b.absFinal / b.actual) * 100) : null;
    const mapeSystem = b.actual ? round1((b.absSys / b.actual) * 100) : null;
    return {
      dimension: b.label,
      actual: Math.round(b.actual),
      final_forecast: Math.round(b.finalForecast),
      system_forecast: Math.round(b.sysForecast),
      mape_final: mapeFinal,
      mape_system: mapeSystem,
      mape_delta: mapeFinal != null && mapeSystem != null ? round1(mapeFinal - mapeSystem) : null,
      bias_final: b.actual ? round1(((b.finalForecast - b.actual) / b.actual) * 100) : null,
      lines: b.rows,
    };
  });

  const totActual = list.reduce((s, b) => s + b.actual, 0);
  const totAbsFinal = list.reduce((s, b) => s + b.absFinal, 0);
  const totAbsSys = list.reduce((s, b) => s + b.absSys, 0);
  const totFinal = list.reduce((s, b) => s + b.finalForecast, 0);

  const summary = [
    { label: "MAPE (Final)", value: totActual ? `${round1((totAbsFinal / totActual) * 100)}%` : "—" },
    { label: "MAPE (System)", value: totActual ? `${round1((totAbsSys / totActual) * 100)}%` : "—" },
    { label: "Bias (Final)", value: totActual ? `${round1(((totFinal - totActual) / totActual) * 100)}%` : "—" },
    { label: "Actual Units", value: Math.round(totActual).toLocaleString() },
    { label: "Scored lines", value: rows.length.toLocaleString() },
  ];

  return {
    columns,
    rows: rows2,
    summary,
    note: "Volume-weighted MAPE & bias. Lower MAPE is better; negative Δ vs System means overrides improved accuracy.",
  };
}
