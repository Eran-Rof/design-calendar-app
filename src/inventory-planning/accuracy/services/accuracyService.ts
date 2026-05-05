// Orchestrates the full Phase 5 pass:
//
//   1. Build actuals from Phase 0 history (wholesale + ecom) into
//      ip_forecast_actuals.
//   2. For a given planning_run, join actuals against the forecasts
//      referenced by the run (wholesale_source_run_id / ecom_source_run_id
//      for 'all' runs, or the run's own forecasts for wholesale/ecom
//      scopes) and persist ip_forecast_accuracy.
//   3. Derive ip_override_effectiveness for rows where system ≠ final.
//   4. Run anomaly detection + heuristic AI suggestions over the set.
//
// Returns a summary the UI can toast.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { ecomRepo } from "../../ecom/services/ecomForecastRepo";
import type { IpPlanningRun } from "../../types/wholesale";
import type { IpIsoDate } from "../../types/entities";
import type {
  IpForecastAccuracy,
  IpForecastActual,
  IpOverrideEffectiveness,
} from "../types/accuracy";
import type { IpAiSuggestion, IpPlanningAnomaly } from "../../intelligence/types/intelligence";
import { computePerRowMetrics, errorDelta, overrideHelped } from "../compute/accuracyMetrics";
import { runAnomalyDetection } from "../../intelligence/compute/anomalyDetection";
import {
  suggestConfidenceAdjustment,
  suggestForecastAdjustment,
  suggestInspectReturnRate,
  suggestProtectionAdjustment,
  scoreBuyerRequestConfidence,
} from "../../intelligence/compute/aiSuggestions";
import { accuracyRepo } from "./accuracyRepo";

// ── period helpers ─────────────────────────────────────────────────────────
function firstOfMonth(iso: IpIsoDate): IpIsoDate { return iso.slice(0, 7) + "-01"; }
function lastOfMonth(iso: IpIsoDate): IpIsoDate {
  const [y, m] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${iso.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}
function mondayOf(iso: IpIsoDate): IpIsoDate {
  const d = new Date(iso + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function sundayOf(iso: IpIsoDate): IpIsoDate {
  const m = mondayOf(iso);
  const d = new Date(m + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}
function weekCodeOf(mondayIso: IpIsoDate): string {
  const d = new Date(mondayIso + "T00:00:00Z");
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dow + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDow + 3);
  const diff = target.getTime() - firstThursday.getTime();
  const week = 1 + Math.floor(diff / (7 * 86_400_000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function earlierIso(iso: string, months: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}
function countTrailingTrue(xs: boolean[]): number {
  let n = 0;
  for (let i = xs.length - 1; i >= 0; i--) {
    if (xs[i]) n++;
    else break;
  }
  return n;
}
function ecomSrcForRun(run: IpPlanningRun): string | null {
  if (run.ecom_source_run_id) return run.ecom_source_run_id;
  if (run.planning_scope === "ecom") return run.id;
  return null;
}
function wholesaleSrcForRun(run: IpPlanningRun): string | null {
  if (run.wholesale_source_run_id) return run.wholesale_source_run_id;
  if (run.planning_scope === "wholesale") return run.id;
  return null;
}

export interface RunAccuracyPassResult {
  actuals_written: number;
  accuracy_rows: number;
  override_rows: number;
  anomalies: number;
  suggestions: number;
}

// ── Build actuals ─────────────────────────────────────────────────────────
export async function buildForecastActuals(
  fromIso: IpIsoDate,
  toIso: IpIsoDate,
): Promise<number> {
  const [wholesale, ecom] = await Promise.all([
    wholesaleRepo.listWholesaleSales(fromIso),
    ecomRepo.listEcomSales(fromIso),
  ]);

  const wsByGrain = new Map<string, Omit<IpForecastActual, "id" | "created_at">>();
  for (const s of wholesale) {
    if (!s.customer_id || !s.sku_id) continue;
    if (s.txn_date < fromIso || s.txn_date > toIso) continue;
    const pStart = firstOfMonth(s.txn_date);
    const pEnd = lastOfMonth(s.txn_date);
    const key = `w:${s.sku_id}:${pStart}:${s.customer_id}`;
    const existing = wsByGrain.get(key) ?? {
      forecast_type: "wholesale" as const,
      sku_id: s.sku_id,
      customer_id: s.customer_id,
      channel_id: null,
      category_id: s.category_id ?? null,
      period_start: pStart,
      period_end: pEnd,
      period_code: pStart.slice(0, 7),
      actual_qty: 0,
      actual_net_sales: 0,
    };
    existing.actual_qty += s.qty;
    existing.actual_net_sales = (existing.actual_net_sales ?? 0) + (s.net_amount ?? 0);
    wsByGrain.set(key, existing);
  }

  const ecByGrain = new Map<string, Omit<IpForecastActual, "id" | "created_at">>();
  for (const s of ecom) {
    if (!s.channel_id || !s.sku_id) continue;
    if (s.order_date < fromIso || s.order_date > toIso) continue;
    const pStart = mondayOf(s.order_date);
    const pEnd = sundayOf(s.order_date);
    const key = `e:${s.sku_id}:${pStart}:${s.channel_id}`;
    const existing = ecByGrain.get(key) ?? {
      forecast_type: "ecom" as const,
      sku_id: s.sku_id,
      customer_id: null,
      channel_id: s.channel_id,
      category_id: s.category_id ?? null,
      period_start: pStart,
      period_end: pEnd,
      period_code: weekCodeOf(pStart),
      actual_qty: 0,
      actual_net_sales: 0,
    };
    existing.actual_qty += (s.qty - s.returned_qty);
    existing.actual_net_sales = (existing.actual_net_sales ?? 0) + (s.net_amount ?? 0);
    ecByGrain.set(key, existing);
  }

  const all = [...wsByGrain.values(), ...ecByGrain.values()];
  await accuracyRepo.upsertActuals(all);
  return all.length;
}

// ── Accuracy + override effectiveness ─────────────────────────────────────
export async function calculateForecastAccuracy(run: IpPlanningRun): Promise<{
  accuracy: Array<Omit<IpForecastAccuracy, "id" | "created_at">>;
  overrideEff: Array<Omit<IpOverrideEffectiveness, "id" | "created_at">>;
  actualsList: IpForecastActual[];
}> {
  const wholesaleSrc = wholesaleSrcForRun(run);
  const ecomSrc = ecomSrcForRun(run);

  const [actuals, wholesaleForecast, ecomForecast, wholesaleOverrides] = await Promise.all([
    accuracyRepo.listActuals(earlierIso(run.source_snapshot_date, 12)),
    wholesaleSrc ? wholesaleRepo.listForecast(wholesaleSrc) : Promise.resolve([]),
    ecomSrc      ? ecomRepo.listForecast(ecomSrc)           : Promise.resolve([]),
    wholesaleSrc ? wholesaleRepo.listOverrides(wholesaleSrc) : Promise.resolve([]),
  ]);

  const actualsByGrain = new Map<string, IpForecastActual>();
  for (const a of actuals) {
    const key = a.forecast_type === "wholesale"
      ? `w:${a.sku_id}:${a.period_start}:${a.customer_id ?? ""}`
      : `e:${a.sku_id}:${a.period_start}:${a.channel_id ?? ""}`;
    actualsByGrain.set(key, a);
  }

  const wsOverrideReason = new Map<string, string>();
  for (const o of wholesaleOverrides) {
    const key = `${o.customer_id}:${o.sku_id}:${o.period_start}`;
    if (!wsOverrideReason.has(key)) wsOverrideReason.set(key, o.reason_code);
  }

  const accuracy: Array<Omit<IpForecastAccuracy, "id" | "created_at">> = [];
  const overrideEff: Array<Omit<IpOverrideEffectiveness, "id" | "created_at">> = [];

  for (const f of wholesaleForecast) {
    const a = actualsByGrain.get(`w:${f.sku_id}:${f.period_start}:${f.customer_id}`);
    if (!a) continue;
    const inputs = {
      system_forecast_qty: f.system_forecast_qty,
      final_forecast_qty: f.final_forecast_qty,
      actual_qty: a.actual_qty,
    };
    const m = computePerRowMetrics(inputs);
    accuracy.push({
      planning_run_id: run.id,
      scenario_id: null,
      forecast_type: "wholesale",
      sku_id: f.sku_id,
      customer_id: f.customer_id,
      channel_id: null,
      category_id: f.category_id,
      period_start: f.period_start,
      period_end: f.period_end,
      period_code: f.period_code,
      forecast_method: f.forecast_method,
      system_forecast_qty: f.system_forecast_qty,
      final_forecast_qty: f.final_forecast_qty,
      actual_qty: a.actual_qty,
      ...m,
    });
    if (f.system_forecast_qty !== f.final_forecast_qty) {
      overrideEff.push({
        planning_run_id: run.id,
        scenario_id: null,
        forecast_type: "wholesale",
        sku_id: f.sku_id,
        customer_id: f.customer_id,
        channel_id: null,
        category_id: f.category_id,
        period_start: f.period_start,
        period_end: f.period_end,
        period_code: f.period_code,
        override_reason: wsOverrideReason.get(`${f.customer_id}:${f.sku_id}:${f.period_start}`) ?? null,
        system_forecast_qty: f.system_forecast_qty,
        final_forecast_qty: f.final_forecast_qty,
        actual_qty: a.actual_qty,
        override_helped_flag: overrideHelped(inputs),
        error_delta: errorDelta(inputs),
      });
    }
  }

  for (const f of ecomForecast) {
    const a = actualsByGrain.get(`e:${f.sku_id}:${f.week_start}:${f.channel_id}`);
    if (!a) continue;
    const inputs = {
      system_forecast_qty: f.system_forecast_qty,
      final_forecast_qty: f.final_forecast_qty,
      actual_qty: a.actual_qty,
    };
    const m = computePerRowMetrics(inputs);
    accuracy.push({
      planning_run_id: run.id,
      scenario_id: null,
      forecast_type: "ecom",
      sku_id: f.sku_id,
      customer_id: null,
      channel_id: f.channel_id,
      category_id: f.category_id,
      period_start: f.week_start,
      period_end: f.week_end,
      period_code: f.period_code,
      forecast_method: f.forecast_method,
      system_forecast_qty: f.system_forecast_qty,
      final_forecast_qty: f.final_forecast_qty,
      actual_qty: a.actual_qty,
      ...m,
    });
    if (f.system_forecast_qty !== f.final_forecast_qty) {
      overrideEff.push({
        planning_run_id: run.id,
        scenario_id: null,
        forecast_type: "ecom",
        sku_id: f.sku_id,
        customer_id: null,
        channel_id: f.channel_id,
        category_id: f.category_id,
        period_start: f.week_start,
        period_end: f.week_end,
        period_code: f.period_code,
        override_reason: null, // ecom override-event reason not joined in MVP
        system_forecast_qty: f.system_forecast_qty,
        final_forecast_qty: f.final_forecast_qty,
        actual_qty: a.actual_qty,
        override_helped_flag: overrideHelped(inputs),
        error_delta: errorDelta(inputs),
      });
    }
  }

  return { accuracy, overrideEff, actualsList: actuals };
}

// ── Full pass ─────────────────────────────────────────────────────────────
export async function runAccuracyAndIntelligencePass(run: IpPlanningRun): Promise<RunAccuracyPassResult> {
  const fromIso = earlierIso(run.source_snapshot_date, 18);
  const toIso = run.source_snapshot_date;

  const actuals_written = await buildForecastActuals(fromIso, toIso);
  const { accuracy, overrideEff, actualsList } = await calculateForecastAccuracy(run);
  await accuracyRepo.replaceAccuracy(accuracy);
  await accuracyRepo.replaceOverrideEffectiveness(run.id, overrideEff);

  // ── trails for anomaly detection
  const accuracyMappedForAnomaly = accuracy.map((r) => ({
    ...r, id: "", created_at: new Date().toISOString(),
  })) as IpForecastAccuracy[];

  const accuracyBySku = new Map<string, IpForecastAccuracy[]>();
  for (const r of accuracyMappedForAnomaly) {
    const arr = accuracyBySku.get(r.sku_id) ?? [];
    arr.push(r);
    accuracyBySku.set(r.sku_id, arr);
  }
  for (const [k, arr] of accuracyBySku) {
    arr.sort((a, b) => a.period_start.localeCompare(b.period_start));
    accuracyBySku.set(k, arr);
  }

  const actualsBySku = new Map<string, number[]>();
  for (const [sku, arr] of accuracyBySku) {
    actualsBySku.set(sku, arr.map((r) => r.actual_qty));
  }

  const [projected, ecomForecastRows] = await Promise.all([
    fetchProjectedForRun(run.id),
    ecomSrcForRun(run) ? ecomRepo.listForecast(ecomSrcForRun(run)!) : Promise.resolve([]),
  ]);
  const stockoutsBySku = new Map<string, boolean[]>();
  for (const p of projected) {
    const arr = stockoutsBySku.get(p.sku_id) ?? [];
    arr.push(p.projected_stockout_flag);
    stockoutsBySku.set(p.sku_id, arr);
  }
  const returnRateBySku = new Map<string, number[]>();
  const protectedUncoveredBySku = new Map<string, boolean[]>();
  for (const e of ecomForecastRows) {
    if (e.return_rate != null) {
      const a = returnRateBySku.get(e.sku_id) ?? [];
      a.push(e.return_rate);
      returnRateBySku.set(e.sku_id, a);
    }
    const uncovered = e.protected_ecom_qty > e.final_forecast_qty;
    const a = protectedUncoveredBySku.get(e.sku_id) ?? [];
    a.push(uncovered);
    protectedUncoveredBySku.set(e.sku_id, a);
  }

  const anomalies: Array<Omit<IpPlanningAnomaly, "id" | "created_at">> = runAnomalyDetection({
    actualsBySku,
    accuracyBySku,
    stockoutsBySku,
    returnRateBySku,
    protectedUncoveredBySku,
    planning_run_id: run.id,
  }, accuracyMappedForAnomaly);

  await accuracyRepo.replaceAnomalies(run.id, anomalies);

  // ── AI suggestions
  const suggestions: Array<Omit<IpAiSuggestion, "id" | "created_at">> = [];
  for (const [sku_id, arr] of accuracyBySku) {
    const latestFinal = arr[arr.length - 1]?.final_forecast_qty ?? 0;
    suggestions.push(...suggestForecastAdjustment(arr, latestFinal, run.id));
    suggestions.push(...suggestConfidenceAdjustment(arr, run.id));

    const protUncovered = protectedUncoveredBySku.get(sku_id) ?? [];
    const protStreak = countTrailingTrue(protUncovered);
    const latestEcom = ecomForecastRows.find((e) => e.sku_id === sku_id);
    if (latestEcom) {
      suggestions.push(...suggestProtectionAdjustment(
        sku_id, latestEcom.week_start, latestEcom.week_end, latestEcom.period_code,
        protStreak, latestEcom.protected_ecom_qty, run.id,
      ));
      if (latestEcom.return_rate != null) {
        suggestions.push(...suggestInspectReturnRate(
          sku_id, latestEcom.week_start, latestEcom.week_end, latestEcom.period_code,
          latestEcom.return_rate, run.id,
        ));
      }
    }
  }

  // Wholesale buyer-request review suggestions.
  const wholesaleSrc = wholesaleSrcForRun(run);
  if (wholesaleSrc) {
    const wholesaleForecast = await wholesaleRepo.listForecast(wholesaleSrc);
    for (const f of wholesaleForecast) {
      if (f.buyer_request_qty <= 0) continue;
      const pairActuals = actualsList.filter(
        (a) => a.forecast_type === "wholesale" &&
               a.sku_id === f.sku_id &&
               a.customer_id === f.customer_id,
      );
      const avg = pairActuals.length > 0
        ? pairActuals.reduce((acc, r) => acc + r.actual_qty, 0) / pairActuals.length
        : 0;
      suggestions.push(...scoreBuyerRequestConfidence(
        f.sku_id, f.period_start, f.period_end, f.period_code,
        f.buyer_request_qty, avg, run.id,
      ));
    }
  }

  await accuracyRepo.replaceSuggestions(run.id, suggestions);

  return {
    actuals_written,
    accuracy_rows: accuracy.length,
    override_rows: overrideEff.length,
    anomalies: anomalies.length,
    suggestions: suggestions.length,
  };
}

// ── Suggestion accept side effect ─────────────────────────────────────────
// Spec: "If accepted, update override or planning input appropriately."
// Phase 5 originally only flipped accepted_flag. This applies the
// suggested value to the underlying forecast row when the suggestion
// type maps cleanly to a planner write, then flips the flag.
//
// Type → action map (kept conservative; types without a clear-cut
// auto-write are still marked accepted but don't push):
//
//   increase_forecast / decrease_forecast
//     → patchForecastSystemOverride to suggested_final_qty (wholesale only)
//   reduce_buy_recommendation
//     → patchForecastBuyQty to suggested_final_qty
//   review_buyer_request / inspect_return_rate / increase_confidence
//   / lower_confidence / protect_more_inventory
//     → no auto-write (planner needs to decide). Mark accepted only.
//
// Ecom suggestions: no auto-write yet — ecom override write path lives
// in a separate repo (ecomRepo) and the surface is smaller. Marking
// accepted records the planner's intent; they apply manually.

export interface ApplySuggestionResult {
  applied: boolean;          // true when a forecast row was patched
  forecast_id_patched?: string | null;
  type: IpAiSuggestion["suggestion_type"];
  reason: string;            // human-readable: "patched override on row X" / "no auto-write for type Y"
}

export async function applyAcceptedSuggestion(
  suggestion: IpAiSuggestion,
  acceptedBy: string | null = null,
): Promise<ApplySuggestionResult> {
  // Branch by suggestion type. Each branch is self-contained so the
  // caller doesn't need to know which suggestions are actionable.
  const type = suggestion.suggestion_type;

  // Wholesale forecast system-override path. Both increase and
  // decrease use the same write; the suggested_final_qty already
  // carries the signed result.
  const writesSystem = type === "increase_forecast" || type === "decrease_forecast";
  const writesBuy = type === "reduce_buy_recommendation";

  let applied = false;
  let forecastIdPatched: string | null = null;
  let reason = `No auto-write defined for ${type}; suggestion marked accepted only.`;

  if ((writesSystem || writesBuy) && suggestion.forecast_type === "wholesale" && suggestion.planning_run_id) {
    const targetQty = suggestion.suggested_final_qty;
    if (targetQty == null) {
      reason = `Suggestion has no suggested_final_qty; nothing to apply.`;
    } else {
      // Find the matching forecast row by (run, sku, period_start,
      // optional customer). Multiple rows for the same sku+period can
      // exist (one per customer); apply to whichever matches when
      // customer_id is set, else the first.
      const forecasts = await wholesaleRepo.listForecast(suggestion.planning_run_id);
      const candidates = forecasts.filter((f) =>
        f.sku_id === suggestion.sku_id
        && f.period_start === suggestion.period_start
        && (!suggestion.customer_id || f.customer_id === suggestion.customer_id),
      );
      if (candidates.length === 0) {
        reason = `No forecast row found for sku ${suggestion.sku_id} period ${suggestion.period_start} on run ${suggestion.planning_run_id}.`;
      } else {
        // Pick the highest-final row when multiple match (most likely
        // the row the suggestion was generated against).
        const target = candidates.sort((a, b) => b.final_forecast_qty - a.final_forecast_qty)[0];
        forecastIdPatched = target.id;
        if (writesSystem) {
          // System override fully replaces the system_forecast_qty
          // when set (see patchForecastSystemOverride contract).
          // final = override + buyer_request + override_qty.
          const newFinal = Math.max(0, targetQty + target.buyer_request_qty + target.override_qty);
          await wholesaleRepo.patchForecastSystemOverride(target.id, Math.round(targetQty), newFinal, acceptedBy);
          applied = true;
          reason = `Applied system override = ${Math.round(targetQty)} on forecast row ${target.id.slice(0, 8)}; final recomputed to ${newFinal}.`;
        } else if (writesBuy) {
          await wholesaleRepo.patchForecastBuyQty(target.id, Math.max(0, Math.round(targetQty)));
          applied = true;
          reason = `Applied planned buy = ${Math.max(0, Math.round(targetQty))} on forecast row ${target.id.slice(0, 8)}.`;
        }
      }
    }
  }

  // Mark accepted regardless (intent is recorded even when no
  // auto-write applied).
  await accuracyRepo.markSuggestion(suggestion.id, true, acceptedBy);

  return { applied, forecast_id_patched: forecastIdPatched, type, reason };
}

// ── misc ───────────────────────────────────────────────────────────────────
async function fetchProjectedForRun(runId: string): Promise<Array<{ sku_id: string; projected_stockout_flag: boolean }>> {
  if (!SB_URL) return [];
  const r = await fetch(
    `${SB_URL}/rest/v1/ip_projected_inventory?select=sku_id,projected_stockout_flag&planning_run_id=eq.${runId}&order=period_start.asc&limit=100000`,
    { headers: SB_HEADERS },
  );
  if (!r.ok) return [];
  return r.json();
}
