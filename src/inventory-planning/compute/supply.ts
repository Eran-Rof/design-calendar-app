// Supply context: turn the Phase 0 fact tables into a per-SKU snapshot
// the planning grid can show. Intentionally simple:
//
//   on_hand       = latest qty_on_hand per sku across warehouses (Xoro)
//   on_po         = sum of qty_open across open POs
//   receipts_due  = sum of qty on ip_receipts_history with received_date
//                   in the period (i.e., already landed in the period
//                   we're planning for, when looking at past periods) —
//                   for future periods we look at open POs with
//                   expected_date in the period.
//   available_supply_qty (for a forward-looking period):
//                 = on_hand + receipts_due
//                   where receipts_due covers the period start → period end.
//
// Rationale for the simple rule: the MVP planner cares about "what do I
// expect to have landed before the end of this period that I can use
// against this forecast". Netting committed/allocated supply across
// shared wholesale+ecom is explicitly Phase 2+.

import type { IpIsoDate } from "../types/entities";
import type { IpOpenPoRow, IpReceiptRow, IpInventorySnapshot } from "../types/entities";

export interface SupplyInputs {
  inventorySnapshots: IpInventorySnapshot[]; // latest-per-sku is enough
  openPos: IpOpenPoRow[];
  receipts: IpReceiptRow[];
}

export interface PeriodSupply {
  on_hand_qty: number;       // raw snapshot (always the Xoro value)
  beginning_balance_qty: number; // rolling start-of-period balance (period 1 = ATS, period 2+ = prior ending)
  on_po_qty: number;
  receipts_due_qty: number;
  available_supply_qty: number;
}

// Collapse inventory snapshots to one number per sku — the latest date
// wins. We sum across warehouses on the latest date so the grid reflects
// "total company on-hand".
export function latestOnHandBySku(snapshots: IpInventorySnapshot[]): Map<string, number> {
  const latestDateBySku = new Map<string, string>();
  for (const s of snapshots) {
    const prev = latestDateBySku.get(s.sku_id);
    if (!prev || s.snapshot_date > prev) latestDateBySku.set(s.sku_id, s.snapshot_date);
  }
  const out = new Map<string, number>();
  for (const s of snapshots) {
    if (latestDateBySku.get(s.sku_id) !== s.snapshot_date) continue;
    out.set(s.sku_id, (out.get(s.sku_id) ?? 0) + (s.qty_on_hand ?? 0));
  }
  return out;
}

export function committedSoBySku(snapshots: IpInventorySnapshot[]): Map<string, number> {
  const latestDateBySku = new Map<string, string>();
  for (const s of snapshots) {
    const prev = latestDateBySku.get(s.sku_id);
    if (!prev || s.snapshot_date > prev) latestDateBySku.set(s.sku_id, s.snapshot_date);
  }
  const out = new Map<string, number>();
  for (const s of snapshots) {
    if (latestDateBySku.get(s.sku_id) !== s.snapshot_date) continue;
    out.set(s.sku_id, (out.get(s.sku_id) ?? 0) + (s.qty_committed ?? 0));
  }
  return out;
}

export function openPoQtyBySku(openPos: IpOpenPoRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of openPos) {
    out.set(p.sku_id, (out.get(p.sku_id) ?? 0) + (p.qty_open ?? 0));
  }
  return out;
}

// Open-PO qty filtered to those whose expected_date lands inside the
// period. Mirrors receiptsDueInPeriod's contract — used by buildGridRows
// for the per-period "On PO" column so May POs don't show on July rows.
// POs with no expected_date are excluded (we can't bucket them).
export function openPoQtyBySkuPeriod(
  openPos: IpOpenPoRow[],
  periodStart: IpIsoDate,
  periodEnd: IpIsoDate,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of openPos) {
    if (!p.expected_date) continue;
    if (p.expected_date < periodStart || p.expected_date > periodEnd) continue;
    out.set(p.sku_id, (out.get(p.sku_id) ?? 0) + (p.qty_open ?? 0));
  }
  return out;
}

// Qty due in [periodStart, periodEnd]. For historical periods we use
// actual ip_receipts_history rows; for future periods we use open POs
// whose expected_date lands in the window. Both sources flow through
// here so the caller doesn't have to decide.
export function receiptsDueInPeriod(
  inputs: Pick<SupplyInputs, "openPos" | "receipts">,
  skuId: string,
  periodStart: IpIsoDate,
  periodEnd: IpIsoDate,
): number {
  let total = 0;
  for (const r of inputs.receipts) {
    if (r.sku_id !== skuId) continue;
    if (r.received_date < periodStart || r.received_date > periodEnd) continue;
    total += r.qty ?? 0;
  }
  for (const p of inputs.openPos) {
    if (p.sku_id !== skuId) continue;
    if (!p.expected_date) continue;
    if (p.expected_date < periodStart || p.expected_date > periodEnd) continue;
    total += p.qty_open ?? 0;
  }
  return total;
}

export function supplyForPeriod(
  inputs: SupplyInputs,
  skuId: string,
  periodStart: IpIsoDate,
  periodEnd: IpIsoDate,
): PeriodSupply {
  const on_hand_qty = latestOnHandBySku(inputs.inventorySnapshots).get(skuId) ?? 0;
  const committed_qty = committedSoBySku(inputs.inventorySnapshots).get(skuId) ?? 0;
  const on_po_qty = openPoQtyBySku(inputs.openPos).get(skuId) ?? 0;
  const receipts_due_qty = receiptsDueInPeriod(inputs, skuId, periodStart, periodEnd);
  const beginning_balance_qty = Math.max(0, on_hand_qty - committed_qty);
  return {
    on_hand_qty,
    beginning_balance_qty,
    on_po_qty,
    receipts_due_qty,
    available_supply_qty: beginning_balance_qty + receipts_due_qty,
  };
}

// Rolling supply across an ordered horizon. Each period's ending balance
// (available − total demand) becomes the next period's beginning. This is
// the correct model for multi-period planning: a PO landing in May is
// consumed in May and only the surplus rolls forward to June.
//
// forecasts must cover all customers for each (sku, period) — demand is
// summed across customers before the roll so shared SKU supply depletes once.
//
// plannedBuyByGrain: optional map of `skuId:periodStart` → planned_buy_qty.
// When set, the planner's intended buy is added to available supply for that
// period and the resulting surplus rolls forward to the next month.
export function buildRollingWholesaleSupply(
  forecasts: Array<{ sku_id: string; period_start: IpIsoDate; final_forecast_qty: number; planned_buy_qty?: number | null }>,
  inputs: SupplyInputs,
  periods: Array<{ period_start: IpIsoDate; period_end: IpIsoDate }>,
): Map<string, PeriodSupply> {
  const onHandMap = latestOnHandBySku(inputs.inventorySnapshots);
  const committedMap = committedSoBySku(inputs.inventorySnapshots);
  const onPoMap = openPoQtyBySku(inputs.openPos);

  // Total demand per (sku, period) — summed across all customers.
  const demandByGrain = new Map<string, number>();
  for (const f of forecasts) {
    const k = `${f.sku_id}:${f.period_start}`;
    demandByGrain.set(k, (demandByGrain.get(k) ?? 0) + f.final_forecast_qty);
  }

  // Planned buy per (sku, period) — summed across customers (buy is SKU-level).
  const buyByGrain = new Map<string, number>();
  for (const f of forecasts) {
    if (f.planned_buy_qty == null) continue;
    const k = `${f.sku_id}:${f.period_start}`;
    // Use max across customers — the buy applies to the SKU for that period.
    buyByGrain.set(k, Math.max(buyByGrain.get(k) ?? 0, f.planned_buy_qty));
  }

  const skuIds = new Set(forecasts.map((f) => f.sku_id));
  const out = new Map<string, PeriodSupply>();

  for (const skuId of skuIds) {
    const on_hand_qty = onHandMap.get(skuId) ?? 0;
    const on_po_qty = onPoMap.get(skuId) ?? 0;
    let rolling = Math.max(0, on_hand_qty - (committedMap.get(skuId) ?? 0));

    for (const p of periods) {
      const receipts_due_qty = receiptsDueInPeriod(inputs, skuId, p.period_start, p.period_end);
      const planned_buy = buyByGrain.get(`${skuId}:${p.period_start}`) ?? 0;
      const beginning_balance_qty = rolling;
      const available_supply_qty = rolling + receipts_due_qty + planned_buy;
      out.set(`${skuId}:${p.period_start}`, { on_hand_qty, beginning_balance_qty, on_po_qty, receipts_due_qty, available_supply_qty });
      const demand = demandByGrain.get(`${skuId}:${p.period_start}`) ?? 0;
      rolling = Math.max(0, available_supply_qty - demand);
    }
  }

  return out;
}
