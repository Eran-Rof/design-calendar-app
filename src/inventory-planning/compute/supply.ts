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
import type { IpOpenPoRow, IpOpenSoRow, IpReceiptRow, IpInventorySnapshot } from "../types/entities";

export interface SupplyInputs {
  inventorySnapshots: IpInventorySnapshot[]; // latest-per-sku is enough
  openPos: IpOpenPoRow[];
  // Open SO commitments. Rolling supply buckets each SO into the period
  // its ship_date falls in (instead of all hitting period 1 like the
  // snapshot's qty_committed aggregate did). When openSos is missing
  // or omitted, the rolling supply falls back to qty_committed at
  // period 1 — matches the previous behavior so a missing feed doesn't
  // silently lose the commitment.
  openSos?: IpOpenSoRow[];
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
// wins. Within the latest date, sum across warehouses but keep only ONE
// row per (sku, warehouse) — prefer source "manual" (ATS Excel) over
// "shopify" over "xoro" so a fresh ATS sync replaces an earlier same-
// day Xoro sync instead of double-counting both.
const SOURCE_PRIORITY: Record<string, number> = { manual: 3, shopify: 2, xoro: 1 };
function pickPreferredSnapshotsOnLatestDate(snapshots: IpInventorySnapshot[]): IpInventorySnapshot[] {
  const latestDateBySku = new Map<string, string>();
  for (const s of snapshots) {
    const prev = latestDateBySku.get(s.sku_id);
    if (!prev || s.snapshot_date > prev) latestDateBySku.set(s.sku_id, s.snapshot_date);
  }
  // For each (sku, warehouse) on the latest date, keep the highest-priority source.
  const winnerKey = (s: IpInventorySnapshot) => `${s.sku_id}:${s.warehouse_code}`;
  const winners = new Map<string, IpInventorySnapshot>();
  for (const s of snapshots) {
    if (latestDateBySku.get(s.sku_id) !== s.snapshot_date) continue;
    const k = winnerKey(s);
    const cur = winners.get(k);
    if (!cur || (SOURCE_PRIORITY[s.source] ?? 0) > (SOURCE_PRIORITY[cur.source] ?? 0)) {
      winners.set(k, s);
    }
  }
  return Array.from(winners.values());
}

export function latestOnHandBySku(snapshots: IpInventorySnapshot[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of pickPreferredSnapshotsOnLatestDate(snapshots)) {
    out.set(s.sku_id, (out.get(s.sku_id) ?? 0) + (s.qty_on_hand ?? 0));
  }
  return out;
}

export function committedSoBySku(snapshots: IpInventorySnapshot[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of pickPreferredSnapshotsOnLatestDate(snapshots)) {
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

// Future inbound: open POs whose expected_date lands in [periodStart,
// periodEnd]. This drives supply math — past receipts are already
// reflected in on_hand_qty (the snapshot value) so counting them here
// would double-count supply for any period that overlaps the snapshot.
export function receiptsDueInPeriod(
  inputs: Pick<SupplyInputs, "openPos">,
  skuId: string,
  periodStart: IpIsoDate,
  periodEnd: IpIsoDate,
): number {
  let total = 0;
  for (const p of inputs.openPos) {
    if (p.sku_id !== skuId) continue;
    if (!p.expected_date) continue;
    if (p.expected_date < periodStart || p.expected_date > periodEnd) continue;
    total += p.qty_open ?? 0;
  }
  return total;
}

// Open SO commitments whose ship_date falls in [periodStart, periodEnd].
// Drives the rolling supply: each period only sheds the SO commitments
// actually shipping in that period instead of taking the full
// qty_committed snapshot off month 1. SOs without a ship_date can't be
// bucketed — caller decides what to do with them (rolling supply
// applies them to the FIRST period as a fallback so no SO is lost).
export function openSoQtyBySkuPeriod(
  openSos: IpOpenSoRow[],
  periodStart: IpIsoDate,
  periodEnd: IpIsoDate,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const so of openSos) {
    if (!so.ship_date) continue;
    if (so.ship_date < periodStart || so.ship_date > periodEnd) continue;
    out.set(so.sku_id, (out.get(so.sku_id) ?? 0) + (so.qty_open ?? 0));
  }
  return out;
}

// SOs with no ship_date — bucketed only by sku, applied to month 1 as a
// fallback when openSos is provided but some lines lack a date. Without
// this, those commitments would be silently dropped.
export function openSoQtyBySkuUndated(openSos: IpOpenSoRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const so of openSos) {
    if (so.ship_date) continue;
    out.set(so.sku_id, (out.get(so.sku_id) ?? 0) + (so.qty_open ?? 0));
  }
  return out;
}

// Past actual receipts that landed in [periodStart, periodEnd]. Display
// only — does NOT feed supply math (those qtys are already in on_hand).
export function historicalReceiptsInPeriod(
  inputs: Pick<SupplyInputs, "receipts">,
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

  // SO commitments bucketed by (sku, period). Built once when openSos
  // is provided so the per-period deduction inside the rolling loop
  // doesn't re-walk the SO array. Falls back to the snapshot
  // qty_committed aggregate (committedMap) when openSos isn't provided
  // — matches the previous "all hits month 1" behavior so a missing
  // feed doesn't silently lose the commitments.
  const useDatedSos = !!inputs.openSos;
  const datedSoMap = new Map<string, number>();
  if (useDatedSos) {
    for (const p of periods) {
      const m = openSoQtyBySkuPeriod(inputs.openSos!, p.period_start, p.period_end);
      for (const [sku, qty] of m) {
        datedSoMap.set(`${sku}:${p.period_start}`, qty);
      }
    }
  }
  // Undated SOs (ship_date missing) — applied to period 1 so the
  // commitment isn't silently dropped from the math. Surfaces as a data-
  // quality issue elsewhere; here we just keep the math conservative.
  const undatedSoMap = useDatedSos ? openSoQtyBySkuUndated(inputs.openSos!) : new Map<string, number>();

  const skuIds = new Set(forecasts.map((f) => f.sku_id));
  const out = new Map<string, PeriodSupply>();

  for (const skuId of skuIds) {
    const on_hand_qty = onHandMap.get(skuId) ?? 0;
    const on_po_qty = onPoMap.get(skuId) ?? 0;
    // Period 1 starting balance:
    // - Dated-SO mode: on_hand minus only the period 1 SO ship-out
    //   plus any undated SOs (conservative: assume they ship soon).
    // - Snapshot mode (legacy / no openSos feed): subtract the whole
    //   qty_committed snapshot from period 1, matching previous
    //   behavior.
    let rolling: number;
    if (useDatedSos) {
      rolling = on_hand_qty;
    } else {
      rolling = Math.max(0, on_hand_qty - (committedMap.get(skuId) ?? 0));
    }

    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      const receipts_due_qty = receiptsDueInPeriod(inputs, skuId, p.period_start, p.period_end);
      const planned_buy = buyByGrain.get(`${skuId}:${p.period_start}`) ?? 0;
      const beginning_balance_qty = rolling;
      const available_supply_qty = rolling + receipts_due_qty + planned_buy;
      out.set(`${skuId}:${p.period_start}`, { on_hand_qty, beginning_balance_qty, on_po_qty, receipts_due_qty, available_supply_qty });
      const demand = demandByGrain.get(`${skuId}:${p.period_start}`) ?? 0;
      const datedSoForPeriod = useDatedSos ? (datedSoMap.get(`${skuId}:${p.period_start}`) ?? 0) : 0;
      // Undated SOs only deplete in period 1 — they're our best guess
      // when ship_date is missing.
      const undatedSoForPeriod = (useDatedSos && i === 0) ? (undatedSoMap.get(skuId) ?? 0) : 0;
      rolling = Math.max(0, available_supply_qty - demand - datedSoForPeriod - undatedSoForPeriod);
    }
  }

  return out;
}

// Apply a top-down rolling pool over an ordered list of grid rows. The
// presentation layer (WholesalePlanningGrid) calls this after sort+aggregate
// so the displayed ATS column matches what the user reads off the screen:
//
//   row[0].displayed_on_hand = totalStartingPool      (ALL on_hand in scope)
//   row[i].displayed_ats     = max(0, on_hand − on_so + receipts + buy)
//   row[i+1].displayed_on_hand = row[i].displayed_ats (carry forward)
//
// totalStartingPool is computed by the caller as the sum of unique-sku
// on_hands across the visible (filtered) row set. on_so_qty is customer-
// scoped so it depletes the pool every row.
//
// Receipts are SKU-scoped facts stamped on every customer row (a single
// PO landing in P1 shows on every customer's row of that SKU). The
// dedupeKey gates receipts so a SKU with 5 customers doesn't contribute
// receipts 5× to the pool — that's the bug fix that brought ATS down
// from billions.
//
// Buy is planner intent saved to a SPECIFIC (customer, sku, period)
// row via saveBucketBuy / saveBuy. It is NOT deduped by grain — each
// row's planned_buy_qty applies to that row's ATS only. Deduping buy
// by (sku, period) silently dropped contributions whenever the planner
// edited buy on a row that wasn't the first-seen for the grain, so
// "type buy → ATS doesn't grow on that row".
export interface RollingPoolFacts {
  on_so_qty: number;
  receipts_due_qty: number;
  planned_buy_qty: number;
  // Final forecast demand. Subtracted from the pool when rolling
  // forward to the next row so the running balance reflects what's
  // actually left after this row's customers are served. Without it,
  // the pool only sheds on_so (small) and absorbs receipts (large)
  // and grows unboundedly across many rows.
  final_forecast_qty?: number;
  // Optional. When set, RECEIPTS contribute to the pool only on the
  // first row sharing this key. Buy is NEVER deduped — it applies
  // per-row regardless. on_so / demand always count per row.
  dedupeKey?: string;
}
export interface RollingPoolResult {
  on_hand_qty: number;       // displayed OnHand at this row (incoming pool)
  available_supply_qty: number; // displayed ATS at this row (outgoing pool, BEFORE demand)
}
export function applyRollingPool<T extends RollingPoolFacts>(
  rows: T[],
  totalStartingPool: number,
): RollingPoolResult[] {
  const out: RollingPoolResult[] = [];
  const seen = new Set<string>();
  let pool = totalStartingPool;
  for (const r of rows) {
    const on_hand_qty = pool;
    let receipts = 0;
    if (!r.dedupeKey || !seen.has(r.dedupeKey)) {
      receipts = r.receipts_due_qty;
      if (r.dedupeKey) seen.add(r.dedupeKey);
    }
    // Buy applies per-row — planner enters it on a specific
    // (customer, sku, period) line, so adding it to that row's ATS
    // is what they expect.
    const buy = r.planned_buy_qty;
    // Displayed ATS — what the planner sees on this row. Doesn't
    // subtract demand (demand is shown separately as Final).
    const ats = Math.max(0, on_hand_qty - r.on_so_qty + receipts + buy);
    out.push({ on_hand_qty, available_supply_qty: ats });
    // Roll-forward — subtract demand so next row's incoming on_hand
    // reflects what's left after this row's customers are served.
    pool = Math.max(0, ats - (r.final_forecast_qty ?? 0));
  }
  return out;
}
