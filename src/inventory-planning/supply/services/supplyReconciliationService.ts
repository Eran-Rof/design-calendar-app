// Orchestrator for the Phase 3 reconciliation pass. Stitches together:
//
//   • demand: ip_wholesale_forecast (wholesale_source_run_id) + ip_ecom_forecast (ecom_source_run_id)
//   • supply: ip_inventory_snapshot (latest per sku) + ip_open_purchase_orders + ip_receipts_history
//   • rules:  ip_allocation_rules (active only)
//
// Flow:
//
//   1. Roll all demand up to monthly buckets per (sku, period).
//      Ecom weekly rows fall in the month that contains their week_start.
//   2. Build supply inputs per (sku, period) — on-hand is the latest
//      snapshot at the run's source_snapshot_date, bucketed into the
//      first period and decremented per-period as it gets allocated.
//      Inbound POs / receipts land in the month of their expected /
//      received date.
//   3. For each (sku, period) in horizon, run buildProjectedInventory
//      (which calls computeAllocation). Replace ip_projected_inventory.
//   4. Generate recommendations + exceptions and replace their tables.
//
// The running on-hand balance rolls forward between periods: the
// ending_inventory_qty of month N becomes the beginning_on_hand_qty of
// month N+1. This keeps the projection coherent across a multi-month
// horizon instead of re-using the same snapshot in every month.

import type { IpPlanningRun } from "../../types/wholesale";
import type { IpIsoDate } from "../../types/entities";
import { monthOf, monthsBetween } from "../../compute/periods";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { ecomRepo } from "../../ecom/services/ecomForecastRepo";
import { supplyRepo } from "./supplyReconciliationRepo";
import { readGender, readGroupName, readSubCategoryName } from "../../types/itemAttributes";
import type {
  DemandInputsForSku,
  IpProjectedInventory,
  ReconciliationInput,
  SupplyInputsForSku,
} from "../types/supply";
import {
  buildProjectedInventory,
  activeRulesForSku,
  generateInventoryRecommendations,
  generateSupplyExceptions,
} from "../compute";

// ── helpers ─────────────────────────────────────────────────────────────────
function monthKey(iso: IpIsoDate): string { return monthOf(iso).period_code; }

function isoInMonth(iso: IpIsoDate, mStart: IpIsoDate, mEnd: IpIsoDate): boolean {
  return iso >= mStart && iso <= mEnd;
}

// ── public: run the full pass ──────────────────────────────────────────────
export interface RunReconciliationResult {
  run_id: string;
  wholesale_source_run_id: string | null;
  ecom_source_run_id: string | null;
  projected_rows: number;
  recommendations: number;
  exceptions: number;
  pairs_considered: number;
}

export async function runReconciliationPass(run: IpPlanningRun): Promise<RunReconciliationResult> {
  if (!run.horizon_start || !run.horizon_end) {
    throw new Error("Reconciliation run has no horizon — set horizon_start + horizon_end.");
  }
  const wholesaleSrc = run.wholesale_source_run_id ?? null;
  const ecomSrc      = run.ecom_source_run_id ?? null;

  // ── masters + supply + rules + demand ─────────────────────────────
  const [
    items,
    categories,
    inv,
    openPos,
    receipts,
    rules,
    wholesaleForecast,
    wholesaleTbd,
    ecomForecast,
    vendorTiming,
  ] = await Promise.all([
    wholesaleRepo.listItems(),
    wholesaleRepo.listCategories(),
    wholesaleRepo.listInventorySnapshots(),
    wholesaleRepo.listOpenPos(),
    wholesaleRepo.listReceipts(earlierIso(run.source_snapshot_date, 24)),
    supplyRepo.listActiveRules(),
    wholesaleSrc ? wholesaleRepo.listForecast(wholesaleSrc) : Promise.resolve([]),
    // Phase 1 TBD rows carry planner-typed buys at the (Supply Only)
    // aggregate level — they don't live on ip_wholesale_forecast, so
    // pulling only `wholesaleForecast` was missing them. listTbdRows
    // returns rows with style_code + planned_buy_qty per (style,
    // customer, period) which we resolve to a sku_id below.
    wholesaleSrc ? wholesaleRepo.listTbdRows(wholesaleSrc) : Promise.resolve([]),
    ecomSrc      ? ecomRepo.listForecast(ecomSrc)           : Promise.resolve([]),
    supplyRepo.listVendorTiming(),
  ]);

  const categoryBySku = new Map<string, string | null>(items.map((i) => [i.id, i.category_id]));
  const months = monthsBetween(run.horizon_start, run.horizon_end);
  if (months.length === 0) {
    await supplyRepo.replaceProjected(run.id, []);
    await supplyRepo.replaceRecommendations(run.id, []);
    await supplyRepo.replaceExceptions(run.id, []);
    return {
      run_id: run.id,
      wholesale_source_run_id: wholesaleSrc,
      ecom_source_run_id: ecomSrc,
      projected_rows: 0, recommendations: 0, exceptions: 0, pairs_considered: 0,
    };
  }

  // ── latest on-hand per sku (Xoro snapshot) ───────────────────────
  const onHandBySku = new Map<string, { qty: number; ats: number }>();
  const latestDateBySku = new Map<string, string>();
  for (const s of inv) {
    const prev = latestDateBySku.get(s.sku_id);
    if (!prev || s.snapshot_date > prev) latestDateBySku.set(s.sku_id, s.snapshot_date);
  }
  for (const s of inv) {
    if (latestDateBySku.get(s.sku_id) !== s.snapshot_date) continue;
    const entry = onHandBySku.get(s.sku_id) ?? { qty: 0, ats: 0 };
    entry.qty += s.qty_on_hand ?? 0;
    entry.ats += s.qty_available ?? 0;
    onHandBySku.set(s.sku_id, entry);
  }

  // ── inbound POs + receipts + planned buys, bucketed to month ─────
  const inboundPoByGrain = new Map<string, number>();
  const receiptsByGrain = new Map<string, number>();
  // Phase 1 planned_buy_qty (the planner's typed buys), bucketed by
  // (sku, period). Pulled from BOTH:
  //   • ip_wholesale_forecast.planned_buy_qty — per-(customer, sku,
  //     period) buys typed at the row level
  //   • ip_wholesale_forecast_tbd.planned_buy_qty — aggregate-level
  //     buys typed at a (style, color, customer, period) grain
  //     (often the (Supply Only) catch-all, where planners enter
  //     stock-buy intent at the style level rather than per customer).
  // Both sources contribute. The run flag controls whether they
  // count toward total_available_supply_qty downstream.
  const plannedBuysByGrain = new Map<string, number>();
  for (const f of wholesaleForecast) {
    const buy = f.planned_buy_qty ?? 0;
    if (buy <= 0) continue;
    const k = `${f.sku_id}:${f.period_start}`;
    plannedBuysByGrain.set(k, (plannedBuysByGrain.get(k) ?? 0) + buy);
  }
  // TBD rows carry style_code (not sku_id). Resolve to a real
  // master variant: prefer (style + color) exact match; fall back
  // to any variant of the style. Skip when style is the literal
  // "TBD" placeholder — those rows have no sku_id to attach buys
  // to in the recon grid.
  const itemByStyleColor = new Map<string, string>();
  const itemByStyle = new Map<string, string>();
  for (const i of items) {
    const style = i.style_code ?? i.sku_code;
    if (!style || style.toUpperCase() === "TBD") continue;
    if (i.color) {
      const k = `${style}|${i.color}`.toLowerCase();
      if (!itemByStyleColor.has(k)) itemByStyleColor.set(k, i.id);
    }
    if (!itemByStyle.has(style)) itemByStyle.set(style, i.id);
  }
  for (const t of wholesaleTbd) {
    const buy = t.planned_buy_qty ?? 0;
    if (buy <= 0) continue;
    if (!t.style_code || t.style_code.toUpperCase() === "TBD") continue;
    const colorKey = t.color && t.color.toUpperCase() !== "TBD"
      ? `${t.style_code}|${t.color}`.toLowerCase()
      : null;
    const skuId = (colorKey && itemByStyleColor.get(colorKey)) ?? itemByStyle.get(t.style_code);
    if (!skuId) continue;
    const k = `${skuId}:${t.period_start}`;
    plannedBuysByGrain.set(k, (plannedBuysByGrain.get(k) ?? 0) + buy);
  }
  const poDetailByGrain = new Map<string, Array<{ po_number: string; expected_date: string | null; qty_open: number }>>();
  for (const po of openPos) {
    if (!po.expected_date) continue;
    const code = monthKey(po.expected_date);
    const k = `${po.sku_id}:${firstOfMonth(po.expected_date)}`;
    inboundPoByGrain.set(k, (inboundPoByGrain.get(k) ?? 0) + (po.qty_open ?? 0));
    const arr = poDetailByGrain.get(k) ?? [];
    arr.push({ po_number: po.po_number, expected_date: po.expected_date, qty_open: po.qty_open });
    poDetailByGrain.set(k, arr);
    void code;
  }
  for (const r of receipts) {
    if (!r.received_date) continue;
    const k = `${r.sku_id}:${firstOfMonth(r.received_date)}`;
    receiptsByGrain.set(k, (receiptsByGrain.get(k) ?? 0) + (r.qty ?? 0));
  }

  // ── demand, bucketed to month ─────────────────────────────────────
  const wholesaleDemand = new Map<string, { total: number; by_customer: Map<string, number> }>();
  for (const f of wholesaleForecast) {
    const k = `${f.sku_id}:${f.period_start}`;
    const entry = wholesaleDemand.get(k) ?? { total: 0, by_customer: new Map() };
    entry.total += f.final_forecast_qty;
    entry.by_customer.set(f.customer_id, (entry.by_customer.get(f.customer_id) ?? 0) + f.final_forecast_qty);
    wholesaleDemand.set(k, entry);
  }

  // Ecom: weekly → roll into the month the week_start falls in.
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

  // ── iterate (sku, month), rolling on-hand forward ────────────────
  // SKU set strategy: when a wholesale source run is linked, the
  // recon scope mirrors that run's forecast — the planner who built
  // a filtered run (e.g. "Joggers only") expects the recon to stay
  // scoped to the same SKUs. Open-PO/receipt-only "supply only"
  // SKUs are ONLY included when no wholesale source is set (free-
  // form recon over everything).
  //
  // Same logic applies to ecom: when ecomSrc is set, only the SKUs
  // it touched are eligible. Both linked → union (sku appears in
  // either demand source).
  const skuSet = new Set<string>();
  const sourceScopedSkus = new Set<string>();
  for (const k of wholesaleDemand.keys()) sourceScopedSkus.add(k.split(":")[0]);
  for (const k of ecomDemand.keys())      sourceScopedSkus.add(k.split(":")[0]);
  // Planned buys (Phase 1) belong to the wholesale source run, so
  // their SKUs are always in scope.
  for (const k of plannedBuysByGrain.keys()) sourceScopedSkus.add(k.split(":")[0]);

  if (wholesaleSrc || ecomSrc) {
    // Source-linked recon — restrict to SKUs in the source run(s).
    for (const sku of sourceScopedSkus) skuSet.add(sku);
  } else {
    // Free-form recon — include every SKU with any inventory or demand
    // signal. Old behavior preserved for un-linked recons.
    for (const sku of sourceScopedSkus)        skuSet.add(sku);
    for (const k of inboundPoByGrain.keys())   skuSet.add(k.split(":")[0]);
    for (const k of receiptsByGrain.keys())    skuSet.add(k.split(":")[0]);
  }

  const projectedRows: Array<Omit<IpProjectedInventory, "id" | "created_at">> = [];
  const protectedShortfall = new Map<string, number>();
  const reserveShortfall = new Map<string, number>();

  for (const skuId of skuSet) {
    // Rolling on-hand seeded from the latest Xoro snapshot.
    let beginning = onHandBySku.get(skuId)?.qty ?? 0;
    const ats = onHandBySku.get(skuId)?.ats ?? 0;
    const categoryId = categoryBySku.get(skuId) ?? null;
    const applicableRules = activeRulesForSku(rules, skuId, categoryId);

    for (const month of months) {
      const grainKey = `${skuId}:${month.period_start}`;
      const supply: SupplyInputsForSku = {
        sku_id: skuId,
        beginning_on_hand_qty: beginning,
        ats_qty: beginning === (onHandBySku.get(skuId)?.qty ?? 0) ? ats : 0,
        inbound_receipts_qty: receiptsByGrain.get(grainKey) ?? 0,
        inbound_po_qty: inboundPoByGrain.get(grainKey) ?? 0,
        inbound_planned_buy_qty: plannedBuysByGrain.get(grainKey) ?? 0,
        wip_qty: 0, // Phase 3 MVP: WIP feed not wired. Exposed for Phase 4.
      };

      const w = wholesaleDemand.get(grainKey);
      const e = ecomDemand.get(grainKey);
      const demand: DemandInputsForSku = {
        sku_id: skuId,
        wholesale_demand_qty: w?.total ?? 0,
        ecom_demand_qty: e?.total ?? 0,
        protected_ecom_qty: e?.protected ?? 0,
        wholesale_by_customer: w
          ? Array.from(w.by_customer, ([customer_id, qty]) => ({ customer_id, qty }))
          : [],
        ecom_by_channel: e
          ? Array.from(e.by_channel, ([channel_id, v]) => ({ channel_id, qty: v.qty, protected: v.protected }))
          : [],
      };

      const input: ReconciliationInput = {
        planning_run_id: run.id,
        period_start: month.period_start,
        period_end: month.period_end,
        period_code: month.period_code,
        sku_id: skuId,
        category_id: categoryId,
        supply,
        demand,
        rules: applicableRules,
        po_detail: poDetailByGrain.get(grainKey),
        vendor_timing: vendorTiming,
        count_planned_buys: !!run.recon_include_planned_buys,
      };

      const row = buildProjectedInventory(input);
      projectedRows.push(row);

      // Shortfalls for the exception / recommendation context maps.
      const protTarget = row.protected_ecom_qty;
      const protCovered = Math.min(protTarget, row.allocated_ecom_qty);
      if (protTarget > protCovered) protectedShortfall.set(grainKey, protTarget - protCovered);

      const reserveTarget = row.reserved_wholesale_qty;
      const reserveCovered = Math.min(reserveTarget, row.allocated_wholesale_qty);
      if (reserveTarget > reserveCovered) reserveShortfall.set(grainKey, reserveTarget - reserveCovered);

      // Roll on-hand forward. ATS only applies to the first month.
      beginning = row.ending_inventory_qty;
    }
  }

  // ── recommendations + exceptions ──────────────────────────────────
  const asOf = new Date().toISOString().slice(0, 10);
  const recs = generateInventoryRecommendations(projectedRows, asOf, {
    protectedShortfall,
    reserveShortfall,
  });
  const exceptions = generateSupplyExceptions(projectedRows, {
    protectedShortfall,
    reserveShortfall,
    poByGrain: poDetailByGrain,
  });

  // ── persist ───────────────────────────────────────────────────────
  await supplyRepo.replaceProjected(run.id, projectedRows);
  await supplyRepo.replaceRecommendations(run.id, recs);
  await supplyRepo.replaceExceptions(run.id, exceptions);

  return {
    run_id: run.id,
    wholesale_source_run_id: wholesaleSrc,
    ecom_source_run_id: ecomSrc,
    projected_rows: projectedRows.length,
    recommendations: recs.length,
    exceptions: exceptions.length,
    pairs_considered: skuSet.size,
  };
}

// ── Grid assembly ──────────────────────────────────────────────────────────
export async function buildReconciliationGrid(run: IpPlanningRun) {
  const [projected, recs, items, categories] = await Promise.all([
    supplyRepo.listProjected(run.id),
    supplyRepo.listRecommendations(run.id),
    wholesaleRepo.listItems(),
    wholesaleRepo.listCategories(),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  // One recommendation per (sku, period) is surfaced on the grid — the
  // highest-priority one. The rest are visible in the drawer.
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const topByGrain = new Map<string, typeof recs[number]>();
  for (const r of recs) {
    const k = `${r.sku_id}:${r.period_start}`;
    const current = topByGrain.get(k);
    if (!current || priorityOrder[r.priority_level] < priorityOrder[current.priority_level]) {
      topByGrain.set(k, r);
    }
  }
  return projected.map((p) => {
    const item = itemById.get(p.sku_id);
    const cat = p.category_id ? categoryById.get(p.category_id) : null;
    const top = topByGrain.get(`${p.sku_id}:${p.period_start}`);
    return {
      projected_id: p.id,
      planning_run_id: p.planning_run_id,
      sku_id: p.sku_id,
      sku_code: item?.sku_code ?? "(unknown sku)",
      sku_description: item?.description ?? null,
      // Phase 3 grid filter dims sourced from item master. Same
      // attribute keys the wholesale grid uses (group_name = Cat,
      // category_name = Sub Cat, gender). Pulled per-row so the
      // workbench filter strip has populated options even when the
      // ip_category_master FK isn't set on the projected_inventory
      // row.
      sku_style: item?.style_code ?? null,
      sku_color: item?.color ?? null,
      group_name: readGroupName(item),
      sub_category_name: readSubCategoryName(item),
      gender: readGender(item),
      category_id: p.category_id,
      category_name: cat?.name ?? null,
      period_code: p.period_code,
      period_start: p.period_start,
      period_end: p.period_end,
      beginning_on_hand_qty: p.beginning_on_hand_qty,
      ats_qty: p.ats_qty,
      inbound_po_qty: p.inbound_po_qty,
      inbound_planned_buy_qty: p.inbound_planned_buy_qty,
      inbound_receipts_qty: p.inbound_receipts_qty,
      wip_qty: p.wip_qty,
      total_available_supply_qty: p.total_available_supply_qty,
      wholesale_demand_qty: p.wholesale_demand_qty,
      ecom_demand_qty: p.ecom_demand_qty,
      protected_ecom_qty: p.protected_ecom_qty,
      reserved_wholesale_qty: p.reserved_wholesale_qty,
      allocated_total_qty: p.allocated_total_qty,
      ending_inventory_qty: p.ending_inventory_qty,
      shortage_qty: p.shortage_qty,
      excess_qty: p.excess_qty,
      projected_stockout_flag: p.projected_stockout_flag,
      top_recommendation: top?.recommendation_type ?? null,
      top_recommendation_qty: top?.recommendation_qty ?? null,
      top_recommendation_priority: top?.priority_level ?? null,
      top_recommendation_reason: top?.action_reason ?? null,
      service_risk_flag: !!top?.service_risk_flag,
    };
  });
}

// ── small helpers ──────────────────────────────────────────────────────────
function earlierIso(iso: IpIsoDate, months: number): IpIsoDate {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}
function firstOfMonth(iso: IpIsoDate): IpIsoDate {
  return iso.slice(0, 7) + "-01";
}
