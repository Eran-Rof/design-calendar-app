// Scenario orchestrator:
//
//   cloneBaseIntoScenario(baseRunId, name, type, note):
//     1. Create a new ip_planning_runs row (planning_scope='all', status='draft')
//        pointing at the same wholesale_source / ecom_source as the base
//     2. Clone ip_wholesale_forecast + ip_ecom_forecast rows from the base
//        into the new run (so the scenario starts equal to its base)
//     3. Insert ip_scenarios row linking both
//     4. Audit
//
//   applyScenarioAssumptions(scenarioId):
//     • Reads assumptions, re-applies them to the cloned forecast rows
//       (patch in place), and optionally adjusts supply inputs by
//       writing delay-shifted rows into a scenario-scoped virtual
//       table (MVP: we just patch expected_date on a copy of open POs
//       that the reconciliation service will see because of its
//       planning_run_id scope? we don't — we feed the reconciler a
//       patched fork of the base open-PO list via the recompute step).
//
//   recomputeScenarioOutputs(scenarioId):
//     • Wipes ip_projected_inventory / recommendations / exceptions
//       for the scenario's planning_run_id and re-runs the Phase 3
//       pass against patched forecast rows.
//
// MVP scope on supply:
//   • receipt_delay_days assumption shifts open-PO expected_date in a
//     scenario-only patched list and replaces projected_inventory
//     directly rather than writing scenario POs back to
//     ip_open_purchase_orders (keeps base clean).

import type { IpPlanningRun } from "../../types/wholesale";
import type { IpProjectedInventory } from "../../supply/types/supply";
import type { IpScenario, IpScenarioType } from "../types/scenarios";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { ecomRepo } from "../../ecom/services/ecomForecastRepo";
import { supplyRepo } from "../../supply/services/supplyReconciliationRepo";
import {
  buildProjectedInventory,
  activeRulesForSku,
  generateInventoryRecommendations,
  generateSupplyExceptions,
} from "../../supply/compute";
import {
  applyAssumptionsToWholesaleRow,
  applyAssumptionsToEcomRow,
  applyReceiptDelayToDate,
  reserveQtyOverrideFor,
} from "../compute";
import { monthOf, monthsBetween } from "../../compute/periods";
import { scenarioRepo } from "./scenarioRepo";
import { logChange } from "./auditLogService";

// ── 1. clone base into scenario ───────────────────────────────────────────
export async function cloneBaseIntoScenario(args: {
  baseRunId: string;
  scenarioName: string;
  scenarioType: IpScenarioType;
  note?: string | null;
  createdBy?: string | null;
}): Promise<IpScenario> {
  const { baseRunId, scenarioName, scenarioType, note, createdBy } = args;
  const baseRun = await fetchRun(baseRunId);
  if (!baseRun) throw new Error("Base planning run not found");

  // 1. New planning_run for the scenario.
  const newRun = await wholesaleRepo.createPlanningRun({
    name: `[Scenario] ${scenarioName}`,
    planning_scope: baseRun.planning_scope === "wholesale" || baseRun.planning_scope === "ecom"
      ? "all" : baseRun.planning_scope,
    status: "draft",
    source_snapshot_date: baseRun.source_snapshot_date,
    horizon_start: baseRun.horizon_start,
    horizon_end: baseRun.horizon_end,
    forecast_method_preference: baseRun.forecast_method_preference,
    wholesale_source_run_id: baseRun.wholesale_source_run_id
                              ?? (baseRun.planning_scope === "wholesale" ? baseRun.id : null),
    ecom_source_run_id: baseRun.ecom_source_run_id
                              ?? (baseRun.planning_scope === "ecom" ? baseRun.id : null),
    note: `Cloned from ${baseRun.id.slice(0, 8)} at ${new Date().toISOString()}`,
    created_by: createdBy ?? null,
  });

  // 2. Clone forecast rows.
  // Wholesale: if base has forecast rows, clone them.
  const baseWholesale = await wholesaleRepo.listForecast(baseRunId);
  if (baseWholesale.length > 0) {
    await wholesaleRepo.upsertForecast(baseWholesale.map((r) => ({
      planning_run_id: newRun.id,
      customer_id: r.customer_id,
      category_id: r.category_id,
      sku_id: r.sku_id,
      period_start: r.period_start,
      period_end: r.period_end,
      period_code: r.period_code,
      system_forecast_qty: r.system_forecast_qty,
      buyer_request_qty: r.buyer_request_qty,
      override_qty: r.override_qty,
      final_forecast_qty: r.final_forecast_qty,
      confidence_level: r.confidence_level,
      forecast_method: r.forecast_method,
      history_months_used: r.history_months_used,
      notes: r.notes,
      ly_reference_qty: r.ly_reference_qty ?? null,
      planned_buy_qty: r.planned_buy_qty ?? null,
      unit_cost_override: r.unit_cost_override ?? null,
    })));
  }
  // Ecom
  const baseEcom = await ecomRepo.listForecast(baseRunId);
  if (baseEcom.length > 0) {
    await ecomRepo.upsertForecast(baseEcom.map((r) => ({
      planning_run_id: newRun.id,
      channel_id: r.channel_id,
      category_id: r.category_id,
      sku_id: r.sku_id,
      week_start: r.week_start,
      week_end: r.week_end,
      period_code: r.period_code,
      system_forecast_qty: r.system_forecast_qty,
      override_qty: r.override_qty,
      final_forecast_qty: r.final_forecast_qty,
      protected_ecom_qty: r.protected_ecom_qty,
      promo_flag: r.promo_flag,
      launch_flag: r.launch_flag,
      markdown_flag: r.markdown_flag,
      forecast_method: r.forecast_method,
      return_rate: r.return_rate,
      seasonality_factor: r.seasonality_factor,
      promo_factor: r.promo_factor,
      launch_factor: r.launch_factor,
      markdown_factor: r.markdown_factor,
      trailing_4w_qty: r.trailing_4w_qty,
      trailing_13w_qty: r.trailing_13w_qty,
      notes: r.notes,
    })));
  }

  // 3. Scenario row.
  const scenario = await scenarioRepo.createScenario({
    planning_run_id: newRun.id,
    scenario_name: scenarioName,
    scenario_type: scenarioType,
    status: "draft",
    base_run_reference_id: baseRunId,
    note: note ?? null,
    created_by: createdBy ?? null,
  });

  await logChange({
    entity_type: "scenario",
    entity_id: scenario.id,
    changed_field: "created",
    new_value: `Cloned from ${baseRunId}`,
    changed_by: createdBy ?? null,
    planning_run_id: newRun.id,
    scenario_id: scenario.id,
    change_reason: note ?? null,
  });

  return scenario;
}

// ── 2. apply assumptions → patch forecast rows in place ───────────────────
export async function applyScenarioAssumptions(scenarioId: string): Promise<{ wholesale: number; ecom: number }> {
  const scenario = await scenarioRepo.getScenario(scenarioId);
  if (!scenario) throw new Error("Scenario not found");
  const assumptions = await scenarioRepo.listAssumptions(scenarioId);

  const [wholesale, ecom] = await Promise.all([
    wholesaleRepo.listForecast(scenario.planning_run_id),
    ecomRepo.listForecast(scenario.planning_run_id),
  ]);

  const patchedWholesale = wholesale.map((r) => applyAssumptionsToWholesaleRow(r, assumptions));
  const patchedEcom = ecom.map((r) => applyAssumptionsToEcomRow(r, assumptions));

  if (patchedWholesale.length > 0) {
    await wholesaleRepo.upsertForecast(patchedWholesale.map((r) => ({
      planning_run_id: r.planning_run_id,
      customer_id: r.customer_id,
      category_id: r.category_id,
      sku_id: r.sku_id,
      period_start: r.period_start,
      period_end: r.period_end,
      period_code: r.period_code,
      system_forecast_qty: r.system_forecast_qty,
      buyer_request_qty: r.buyer_request_qty,
      override_qty: r.override_qty,
      final_forecast_qty: r.final_forecast_qty,
      confidence_level: r.confidence_level,
      forecast_method: r.forecast_method,
      history_months_used: r.history_months_used,
      notes: r.notes,
    })));
  }
  if (patchedEcom.length > 0) {
    await ecomRepo.upsertForecast(patchedEcom.map((r) => ({
      planning_run_id: r.planning_run_id,
      channel_id: r.channel_id,
      category_id: r.category_id,
      sku_id: r.sku_id,
      week_start: r.week_start,
      week_end: r.week_end,
      period_code: r.period_code,
      system_forecast_qty: r.system_forecast_qty,
      override_qty: r.override_qty,
      final_forecast_qty: r.final_forecast_qty,
      protected_ecom_qty: r.protected_ecom_qty,
      promo_flag: r.promo_flag,
      launch_flag: r.launch_flag,
      markdown_flag: r.markdown_flag,
      forecast_method: r.forecast_method,
      return_rate: r.return_rate,
      seasonality_factor: r.seasonality_factor,
      promo_factor: r.promo_factor,
      launch_factor: r.launch_factor,
      markdown_factor: r.markdown_factor,
      trailing_4w_qty: r.trailing_4w_qty,
      trailing_13w_qty: r.trailing_13w_qty,
      notes: r.notes,
    })));
  }
  return { wholesale: patchedWholesale.length, ecom: patchedEcom.length };
}

// ── 3. recompute supply reconciliation for the scenario ────────────────────
// We re-run the Phase 3 logic in-process using the patched forecasts and
// (optionally) a shifted open-PO list. Writes directly to
// ip_projected_inventory / ip_inventory_recommendations / ip_supply_exceptions
// for the scenario's planning_run_id.
export async function recomputeScenarioOutputs(scenarioId: string): Promise<{
  projected_rows: number; recommendations: number; exceptions: number;
}> {
  const scenario = await scenarioRepo.getScenario(scenarioId);
  if (!scenario) throw new Error("Scenario not found");
  const run = await fetchRun(scenario.planning_run_id);
  if (!run || !run.horizon_start || !run.horizon_end) throw new Error("Scenario run has no horizon");

  const [
    items,
    inv,
    openPosBase,
    receipts,
    rules,
    wholesaleForecast,
    ecomForecast,
    assumptions,
  ] = await Promise.all([
    wholesaleRepo.listItems(),
    wholesaleRepo.listInventorySnapshots(),
    wholesaleRepo.listOpenPos(),
    wholesaleRepo.listReceipts(earlierIso(run.source_snapshot_date, 24)),
    supplyRepo.listActiveRules(),
    wholesaleRepo.listForecast(run.id),
    ecomRepo.listForecast(run.id),
    scenarioRepo.listAssumptions(scenarioId),
  ]);

  // Apply receipt_delay_days to a COPY of the PO list so the base stays
  // intact on ip_open_purchase_orders.
  const receiptDelayDays = assumptions
    .filter((a) => a.assumption_type === "receipt_delay_days")
    .reduce((acc, a) => acc + (a.assumption_value ?? 0), 0);
  const openPos = openPosBase.map((p) => receiptDelayDays !== 0
    ? { ...p, expected_date: applyReceiptDelayToDate(p.expected_date, receiptDelayDays) }
    : p);

  // ── build monthly buckets (same as Phase 3 orchestrator) ────────────────
  const categoryBySku = new Map<string, string | null>(items.map((i) => [i.id, i.category_id]));
  const months = monthsBetween(run.horizon_start, run.horizon_end);

  const onHandBySku = new Map<string, { qty: number; ats: number }>();
  const latestDateBySku = new Map<string, string>();
  for (const s of inv) {
    const prev = latestDateBySku.get(s.sku_id);
    if (!prev || s.snapshot_date > prev) latestDateBySku.set(s.sku_id, s.snapshot_date);
  }
  for (const s of inv) {
    if (latestDateBySku.get(s.sku_id) !== s.snapshot_date) continue;
    const e = onHandBySku.get(s.sku_id) ?? { qty: 0, ats: 0 };
    e.qty += s.qty_on_hand ?? 0;
    e.ats += s.qty_available ?? 0;
    onHandBySku.set(s.sku_id, e);
  }

  const inboundPoByGrain = new Map<string, number>();
  const receiptsByGrain = new Map<string, number>();
  const poDetailByGrain = new Map<string, Array<{ po_number: string; expected_date: string | null; qty_open: number }>>();
  for (const po of openPos) {
    if (!po.expected_date) continue;
    const k = `${po.sku_id}:${firstOfMonth(po.expected_date)}`;
    inboundPoByGrain.set(k, (inboundPoByGrain.get(k) ?? 0) + (po.qty_open ?? 0));
    const arr = poDetailByGrain.get(k) ?? [];
    arr.push({ po_number: po.po_number, expected_date: po.expected_date, qty_open: po.qty_open });
    poDetailByGrain.set(k, arr);
  }
  for (const r of receipts) {
    if (!r.received_date) continue;
    const k = `${r.sku_id}:${firstOfMonth(r.received_date)}`;
    receiptsByGrain.set(k, (receiptsByGrain.get(k) ?? 0) + (r.qty ?? 0));
  }

  const wholesaleDemand = new Map<string, { total: number; by_customer: Map<string, number> }>();
  for (const f of wholesaleForecast) {
    const k = `${f.sku_id}:${f.period_start}`;
    const entry = wholesaleDemand.get(k) ?? { total: 0, by_customer: new Map() };
    entry.total += f.final_forecast_qty;
    entry.by_customer.set(f.customer_id, (entry.by_customer.get(f.customer_id) ?? 0) + f.final_forecast_qty);
    wholesaleDemand.set(k, entry);
  }
  const ecomDemand = new Map<string, {
    total: number; protected: number;
    by_channel: Map<string, { qty: number; protected: number }>;
  }>();
  for (const f of ecomForecast) {
    const mStart = firstOfMonth(f.week_start);
    const k = `${f.sku_id}:${mStart}`;
    const entry = ecomDemand.get(k) ?? { total: 0, protected: 0, by_channel: new Map() };
    entry.total += f.final_forecast_qty;
    entry.protected += f.protected_ecom_qty;
    const ch = entry.by_channel.get(f.channel_id) ?? { qty: 0, protected: 0 };
    ch.qty += f.final_forecast_qty;
    ch.protected += f.protected_ecom_qty;
    entry.by_channel.set(f.channel_id, ch);
    ecomDemand.set(k, entry);
  }

  const skuSet = new Set<string>();
  for (const k of wholesaleDemand.keys()) skuSet.add(k.split(":")[0]);
  for (const k of ecomDemand.keys())      skuSet.add(k.split(":")[0]);
  for (const k of inboundPoByGrain.keys())skuSet.add(k.split(":")[0]);
  for (const k of receiptsByGrain.keys()) skuSet.add(k.split(":")[0]);

  const projectedRows: Array<Omit<IpProjectedInventory, "id" | "created_at">> = [];
  const protectedShortfall = new Map<string, number>();
  const reserveShortfall = new Map<string, number>();

  for (const skuId of skuSet) {
    let beginning = onHandBySku.get(skuId)?.qty ?? 0;
    const ats = onHandBySku.get(skuId)?.ats ?? 0;
    const categoryId = categoryBySku.get(skuId) ?? null;
    const baseRules = activeRulesForSku(rules, skuId, categoryId);

    // Apply reserve_qty_override from assumptions by cloning matching rules.
    const reserveOverride = reserveQtyOverrideFor(assumptions, null, categoryId, skuId);
    const applicableRules = reserveOverride != null ? baseRules.map((r) => ({ ...r, reserve_qty: reserveOverride, reserve_percent: null })) : baseRules;

    for (const month of months) {
      const grainKey = `${skuId}:${month.period_start}`;
      const w = wholesaleDemand.get(grainKey);
      const e = ecomDemand.get(grainKey);

      const supply = {
        sku_id: skuId,
        beginning_on_hand_qty: beginning,
        ats_qty: beginning === (onHandBySku.get(skuId)?.qty ?? 0) ? ats : 0,
        inbound_receipts_qty: receiptsByGrain.get(grainKey) ?? 0,
        inbound_po_qty: inboundPoByGrain.get(grainKey) ?? 0,
        wip_qty: 0,
      };
      const demand = {
        sku_id: skuId,
        wholesale_demand_qty: w?.total ?? 0,
        ecom_demand_qty: e?.total ?? 0,
        protected_ecom_qty: e?.protected ?? 0,
        wholesale_by_customer: w ? Array.from(w.by_customer, ([customer_id, qty]) => ({ customer_id, qty })) : [],
        ecom_by_channel: e ? Array.from(e.by_channel, ([channel_id, v]) => ({ channel_id, qty: v.qty, protected: v.protected })) : [],
      };

      const row = buildProjectedInventory({
        planning_run_id: run.id,
        period_start: month.period_start,
        period_end: month.period_end,
        period_code: month.period_code,
        sku_id: skuId,
        category_id: categoryId,
        supply, demand,
        rules: applicableRules,
        po_detail: poDetailByGrain.get(grainKey),
      });
      projectedRows.push(row);

      const protTarget = row.protected_ecom_qty;
      const protCovered = Math.min(protTarget, row.allocated_ecom_qty);
      if (protTarget > protCovered) protectedShortfall.set(grainKey, protTarget - protCovered);
      const reserveTarget = row.reserved_wholesale_qty;
      const reserveCovered = Math.min(reserveTarget, row.allocated_wholesale_qty);
      if (reserveTarget > reserveCovered) reserveShortfall.set(grainKey, reserveTarget - reserveCovered);

      beginning = row.ending_inventory_qty;
    }
  }

  const asOf = new Date().toISOString().slice(0, 10);
  const recs = generateInventoryRecommendations(projectedRows, asOf, { protectedShortfall, reserveShortfall });
  const exceptions = generateSupplyExceptions(projectedRows, { protectedShortfall, reserveShortfall, poByGrain: poDetailByGrain });

  await supplyRepo.replaceProjected(run.id, projectedRows);
  await supplyRepo.replaceRecommendations(run.id, recs);
  await supplyRepo.replaceExceptions(run.id, exceptions);

  return { projected_rows: projectedRows.length, recommendations: recs.length, exceptions: exceptions.length };
}

// ── helpers ────────────────────────────────────────────────────────────────
async function fetchRun(id: string): Promise<IpPlanningRun | null> {
  return wholesaleRepo.getPlanningRun(id);
}
function earlierIso(iso: string, months: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}
function firstOfMonth(iso: string): string {
  return iso.slice(0, 7) + "-01";
}
