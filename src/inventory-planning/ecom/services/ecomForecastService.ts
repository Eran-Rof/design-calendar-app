// Orchestrates ecom compute + persistence. Mirrors
// wholesaleForecastService.ts so planners get a familiar shape:
//
//   runEcomForecastPass(run)
//   applyEcomOverride(...)
//   buildEcomGridRows(run)
//
// All three read from Phase 0 history and Phase 2 forecast tables.

import type { IpIsoDate } from "../../types/entities";
import type { IpPlanningRun } from "../../types/wholesale";
import { weekOf, weeksBetween, weekOffset } from "../../compute/periods";
import type {
  IpEcomForecast,
  IpEcomForecastComputeInput,
  IpEcomForecastMethod,
  IpEcomGridRow,
  IpEcomOverrideReason,
} from "../types/ecom";
import { buildFinalEcomForecast } from "../compute/ecomForecast";
import { ecomRepo } from "./ecomForecastRepo";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";

function lookbackSince(snapshot: IpIsoDate, weeks: number): IpIsoDate {
  const d = new Date(snapshot + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - weeks * 7);
  return d.toISOString().slice(0, 10);
}

export interface RunEcomForecastResult {
  run_id: string;
  forecast_rows_written: number;
  triples_considered: number;
  methods: Record<IpEcomForecastMethod, number>;
}

export async function runEcomForecastPass(run: IpPlanningRun): Promise<RunEcomForecastResult> {
  if (!run.horizon_start || !run.horizon_end) {
    throw new Error("Planning run has no horizon; set horizon_start + horizon_end.");
  }
  const snapshot = run.source_snapshot_date;
  // 26-week lookback for seasonality + trailing windows.
  const lookbackFrom = lookbackSince(snapshot, 26);

  const [items, channels, sales, statuses, overrideEvents] = await Promise.all([
    wholesaleRepo.listItems(),
    ecomRepo.listChannels(),
    ecomRepo.listEcomSales(lookbackFrom),
    ecomRepo.listProductChannelStatus(),
    ecomRepo.listOverrides(run.id),
  ]);

  // Most recent override per grain wins.
  const latestOvByGrain = new Map<string, typeof overrideEvents[number]>();
  for (const o of overrideEvents) {
    const k = `${o.channel_id}:${o.sku_id}:${o.week_start}`;
    if (!latestOvByGrain.has(k)) latestOvByGrain.set(k, o);
  }

  // Build triple list from product_channel_status ∪ history. Only emit
  // rows where the channel is an ecom channel the repo returned.
  const ecomChannelIds = new Set(channels.map((c) => c.id));
  const categoryBySku = new Map<string, string | null>(items.map((i) => [i.id, i.category_id]));
  const seen = new Set<string>();
  const triples: IpEcomForecastComputeInput["triples"] = [];

  for (const s of statuses) {
    if (!ecomChannelIds.has(s.channel_id)) continue;
    const k = `${s.channel_id}:${s.sku_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    triples.push({
      channel_id: s.channel_id,
      sku_id: s.sku_id,
      category_id: categoryBySku.get(s.sku_id) ?? null,
      launch_date: s.launch_date ?? null,
      markdown_flag: !!s.markdown_flag,
      is_active: !!s.is_active,
    });
  }
  for (const row of sales) {
    if (!ecomChannelIds.has(row.channel_id)) continue;
    const k = `${row.channel_id}:${row.sku_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    triples.push({
      channel_id: row.channel_id,
      sku_id: row.sku_id,
      category_id: row.category_id ?? categoryBySku.get(row.sku_id) ?? null,
      launch_date: null,
      markdown_flag: false,
      is_active: true,
    });
  }

  const history: IpEcomForecastComputeInput["history"] = sales.map((s) => ({
    channel_id: s.channel_id,
    sku_id: s.sku_id,
    category_id: s.category_id ?? categoryBySku.get(s.sku_id) ?? null,
    order_date: s.order_date,
    qty: s.qty,
    returned_qty: s.returned_qty,
  }));

  const overrides = Array.from(latestOvByGrain.values()).map((o) => ({
    channel_id: o.channel_id,
    sku_id: o.sku_id,
    week_start: o.week_start,
    override_qty: o.override_qty,
  }));

  const rows = buildFinalEcomForecast({
    planning_run_id: run.id,
    source_snapshot_date: snapshot,
    horizon_start: run.horizon_start,
    horizon_end: run.horizon_end,
    triples,
    history,
    overrides,
  });

  await ecomRepo.upsertForecast(rows);

  const methods: Record<IpEcomForecastMethod, number> = {
    trailing_4w: 0, trailing_13w: 0, weighted_recent: 0, seasonality: 0,
    launch_curve: 0, category_fallback: 0, zero_floor: 0,
  };
  for (const r of rows) methods[r.forecast_method]++;

  return {
    run_id: run.id,
    forecast_rows_written: rows.length,
    triples_considered: triples.length,
    methods,
  };
}

// ── Override flow ──────────────────────────────────────────────────────────
export async function applyEcomOverride(args: {
  forecast: IpEcomForecast;
  override_qty: number;
  reason_code: IpEcomOverrideReason;
  note?: string | null;
  created_by?: string | null;
}): Promise<IpEcomForecast> {
  const { forecast, override_qty, reason_code, note, created_by } = args;
  const final = Math.max(0, forecast.system_forecast_qty + override_qty);
  // Audit first, then patch the row.
  await ecomRepo.createOverride({
    planning_run_id: forecast.planning_run_id,
    channel_id: forecast.channel_id,
    category_id: forecast.category_id,
    sku_id: forecast.sku_id,
    week_start: forecast.week_start,
    week_end: forecast.week_end,
    override_qty,
    reason_code,
    note: note ?? null,
    created_by: created_by ?? null,
  });
  return ecomRepo.patchForecastOverride(forecast.id, override_qty, final);
}

// ── Grid assembly ──────────────────────────────────────────────────────────
export async function buildEcomGridRows(run: IpPlanningRun): Promise<IpEcomGridRow[]> {
  const [items, channels, categories, forecast, statuses] = await Promise.all([
    wholesaleRepo.listItems(),
    ecomRepo.listChannels(),
    ecomRepo.listCategories(),
    ecomRepo.listForecast(run.id),
    ecomRepo.listProductChannelStatus(),
  ]);

  const itemById = new Map(items.map((i) => [i.id, i]));
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const statusByGrain = new Map(statuses.map((s) => [`${s.channel_id}:${s.sku_id}`, s]));

  return forecast.map((f) => {
    const item = itemById.get(f.sku_id);
    const channel = channelById.get(f.channel_id);
    const category = f.category_id ? categoryById.get(f.category_id) : null;
    const status = statusByGrain.get(`${f.channel_id}:${f.sku_id}`);
    const t4 = f.trailing_4w_qty ?? 0;
    const t13 = f.trailing_13w_qty ?? 0;
    // trend_pct = (4-week run rate / 13-week run rate) - 1, only when 13w has data
    const trend_pct = t13 > 0 ? (t4 / 4) / (t13 / 13) - 1 : null;
    return {
      forecast_id: f.id,
      planning_run_id: f.planning_run_id,
      channel_id: f.channel_id,
      channel_name: channel?.name ?? "(unknown channel)",
      category_id: f.category_id,
      category_name: category?.name ?? null,
      sku_id: f.sku_id,
      sku_code: item?.sku_code ?? "(unknown sku)",
      sku_description: item?.description ?? null,
      period_code: f.period_code,
      week_start: f.week_start,
      week_end: f.week_end,
      trailing_4w_qty: t4,
      trailing_13w_qty: t13,
      trend_pct,
      system_forecast_qty: f.system_forecast_qty,
      override_qty: f.override_qty,
      final_forecast_qty: f.final_forecast_qty,
      protected_ecom_qty: f.protected_ecom_qty,
      promo_flag: f.promo_flag,
      launch_flag: f.launch_flag,
      markdown_flag: f.markdown_flag,
      is_active: status?.is_active ?? true,
      return_rate: f.return_rate ?? null,
      forecast_method: f.forecast_method,
      notes: f.notes,
    };
  });
}

// ── Chart data assembly ────────────────────────────────────────────────────
// Returns a combined timeline: historical weeks (from sales) + forecast
// weeks (from ip_ecom_forecast) for a single (channel, sku). Used by
// EcomForecastChart.
export interface EcomChartPoint {
  period_code: string;
  week_start: IpIsoDate;
  historical_qty: number | null;
  system_forecast_qty: number | null;
  final_forecast_qty: number | null;
}

export async function loadEcomChartSeries(
  run: IpPlanningRun,
  channelId: string,
  skuId: string,
  lookbackWeeks = 26,
): Promise<EcomChartPoint[]> {
  if (!run.horizon_start || !run.horizon_end) return [];
  const since = lookbackSince(run.source_snapshot_date, lookbackWeeks);
  const [sales, forecast] = await Promise.all([
    ecomRepo.listEcomSales(since),
    ecomRepo.listForecast(run.id),
  ]);
  const hist = new Map<string, number>();
  for (const s of sales) {
    if (s.channel_id !== channelId || s.sku_id !== skuId) continue;
    const code = weekOf(s.order_date).period_code;
    hist.set(code, (hist.get(code) ?? 0) + s.qty - s.returned_qty);
  }
  const forecastByCode = new Map<string, { sys: number; final: number }>();
  for (const f of forecast) {
    if (f.channel_id !== channelId || f.sku_id !== skuId) continue;
    forecastByCode.set(f.period_code, { sys: f.system_forecast_qty, final: f.final_forecast_qty });
  }

  // Walk weeks from (snapshot - lookback) through horizon_end.
  const historyWeeks: { period_code: string; week_start: IpIsoDate }[] = [];
  for (let i = lookbackWeeks; i > 0; i--) {
    const w = weekOffset(run.source_snapshot_date, i);
    historyWeeks.push({ period_code: w.period_code, week_start: w.week_start });
  }
  const forecastWeeks = weeksBetween(run.horizon_start, run.horizon_end);
  const points: EcomChartPoint[] = [];
  for (const w of historyWeeks) {
    points.push({
      period_code: w.period_code,
      week_start: w.week_start,
      historical_qty: hist.get(w.period_code) ?? 0,
      system_forecast_qty: null,
      final_forecast_qty: null,
    });
  }
  for (const w of forecastWeeks) {
    const f = forecastByCode.get(w.period_code);
    points.push({
      period_code: w.period_code,
      week_start: w.week_start,
      historical_qty: null,
      system_forecast_qty: f?.sys ?? 0,
      final_forecast_qty: f?.final ?? 0,
    });
  }
  return points;
}
