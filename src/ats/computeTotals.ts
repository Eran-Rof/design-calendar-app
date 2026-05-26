import type { ATSRow, ATSPoEvent, ATSSoEvent } from "./types";
import { periodAvail } from "./compute";

// Per-slot totals: Qty + Cost ($) + Sale ($) + skipped (SKUs we couldn't
// resolve a cost/sale for, surfaced as the red asterisk on the grid's
// Mrgn label).
export type GridTotalsSlot = {
  qty: number;
  cost: number;
  sale: number;
  skipped: number;
};

export interface GridTotals {
  onHand: GridTotalsSlot;
  onOrder: GridTotalsSlot;
  onPO: GridTotalsSlot;
  // Keyed by period.key (which equals period.endDate in every
  // rangeUnit). Period-bucketed totals — the export joins these into
  // the date-column totals.
  periodQty: Record<string, number>;
  periodCost: Record<string, number>;
  periodSale: Record<string, number>;
  periodSkipped: Record<string, number>;
  // Per-period flow $ — receipts (POs arriving) and COGS (SOs shipping).
  // Always computed from eventIndex regardless of viewMode so the
  // totals-row B/E Inven chain has consistent flows even when the
  // operator switches between ATS / SO / PO views. Both use the SKU's
  // resolved cost (avg cost → PO weighted-avg → margin-derived).
  periodReceiptsValue: Record<string, number>;
  periodCogsValue: Record<string, number>;
}

export interface ComputeTotalsOpts {
  filtered: ATSRow[];
  displayPeriods: Array<{ key: string; periodStart: string; endDate: string; label: string }>;
  viewMode: "ats" | "so" | "po";
  eventIndex: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> | null;
  generalMarginPct: number;
}

// Pure totals function shared between the on-screen totals row in
// GridTable and the Excel export. Lifted out of GridTable.tsx so a
// second consumer (the export) computes the SAME numbers — no drift
// between what the planner reads on screen and what lands in Excel.
//
// Per-SKU resolution chain (drives Cost and Sale):
//   sale: SO avg price from events   →  cost / (1 − margin%)  if no SO
//   cost: row.avgCost (inventory)    →  PO avg unitCost       →  sale × (1 − margin%) if no SO either
//   skip: SKU with no SO, no avgCost, AND no PO cost → ignored
//         and counted in `skipped` so the grid label can show a `*`.
export function computeGridTotals(opts: ComputeTotalsOpts): GridTotals {
  const { filtered, displayPeriods, viewMode, eventIndex } = opts;
  const m = Math.max(0, Math.min(99, opts.generalMarginPct ?? 50)) / 100;
  const oneMinusM = 1 - m;

  // Per-SKU PPK multiplier from filtered rows. Raw Xoro PO/SO events
  // come at PACK grain — soVal/soQty and poVal/poQty are per-pack
  // dollars. The qty fields on r (onHand / onOrder / onPO / dates)
  // are unit-grain (compute.ts already multiplies by ppkMult), so
  // multiplying unit qty × per-pack price would inflate cost/sale
  // totals by ppkMult on prepacks. Divide the per-pack price by
  // ppkMult here so soPriceBySku / poCostBySku land in per-unit
  // grain — matching avgCostBySku, which is already per-unit
  // because compute.ts divides r.avgCost by ppkMult on ingest.
  const ppkMultBySku = new Map<string, number>();
  for (const r of filtered) {
    const mult = r.ppkMult ?? 1;
    if (mult > 1) ppkMultBySku.set(r.sku, mult);
  }

  const soPriceBySku = new Map<string, number>();
  const poCostBySku = new Map<string, number>();
  if (eventIndex) {
    for (const sku of Object.keys(eventIndex)) {
      let soQty = 0, soVal = 0, poQty = 0, poVal = 0;
      for (const buckets of Object.values(eventIndex[sku])) {
        for (const so of buckets.sos) {
          const v = so.totalPrice || (so.unitPrice * so.qty) || 0;
          if (so.qty > 0 && v > 0) { soQty += so.qty; soVal += v; }
        }
        for (const po of buckets.pos) {
          if (po.qty > 0 && po.unitCost > 0) { poQty += po.qty; poVal += po.qty * po.unitCost; }
        }
      }
      const mult = ppkMultBySku.get(sku) ?? 1;
      if (soQty > 0) soPriceBySku.set(sku, (soVal / soQty) / mult);
      if (poQty > 0) poCostBySku.set(sku, (poVal / poQty) / mult);
    }
  }

  // First pass: capture the BEST avgCost per SKU across every store
  // row in the filtered set. avgCost is per (sku, store) so a SKU
  // can have a $5 cost on its ROF row but $0 on its ROF ECOM row;
  // resolving on whichever row appears first would mis-skip half
  // the inventory.
  const avgCostBySku = new Map<string, number>();
  for (const r of filtered) {
    if (r.avgCost && r.avgCost > 0) {
      const cur = avgCostBySku.get(r.sku);
      if (cur == null || r.avgCost > cur) avgCostBySku.set(r.sku, r.avgCost);
    }
  }

  type Resolved = { cost: number; sale: number };
  const resolved = new Map<string, Resolved | null>();
  for (const r of filtered) {
    if (resolved.has(r.sku)) continue;
    const so = soPriceBySku.get(r.sku);
    const po = poCostBySku.get(r.sku);
    const ac = avgCostBySku.get(r.sku);
    const costKnown = ac ?? po ?? null;
    if (so == null && costKnown == null) {
      resolved.set(r.sku, null);
      continue;
    }
    let cost: number, sale: number;
    if (so != null && costKnown != null) {
      cost = costKnown;
      sale = so;
    } else if (so != null) {
      cost = so * oneMinusM;
      sale = so;
    } else {
      cost = costKnown!;
      sale = oneMinusM > 0 ? costKnown! / oneMinusM : costKnown!;
    }
    resolved.set(r.sku, { cost, sale });
  }

  let onHandQty = 0, onHandCost = 0, onHandSale = 0, onHandSkipped = 0;
  let onOrderQty = 0, onOrderCost = 0, onOrderSale = 0, onOrderSkipped = 0;
  let onPOQty = 0, onPOCost = 0, onPOSale = 0, onPOSkipped = 0;
  for (const r of filtered) {
    onHandQty += r.onHand || 0;
    onOrderQty += r.onOrder || 0;
    onPOQty += r.onPO || 0;
    const res = resolved.get(r.sku);
    if (!res) {
      if ((r.onHand || 0) > 0) onHandSkipped++;
      if ((r.onOrder || 0) > 0) onOrderSkipped++;
      if ((r.onPO || 0) > 0) onPOSkipped++;
      continue;
    }
    onHandCost += (r.onHand || 0) * res.cost; onHandSale += (r.onHand || 0) * res.sale;
    onOrderCost += (r.onOrder || 0) * res.cost; onOrderSale += (r.onOrder || 0) * res.sale;
    onPOCost += (r.onPO || 0) * res.cost; onPOSale += (r.onPO || 0) * res.sale;
  }

  const periodQty: Record<string, number> = {};
  const periodCost: Record<string, number> = {};
  const periodSale: Record<string, number> = {};
  const periodSkipped: Record<string, number> = {};
  const periodReceiptsValue: Record<string, number> = {};
  const periodCogsValue: Record<string, number> = {};
  for (let pi = 0; pi < displayPeriods.length; pi++) {
    const p = displayPeriods[pi];
    let q = 0, c = 0, s = 0, skipped = 0;
    // Receipts$ / COGS$ are flow values driven by PO / SO events
    // landing in the period — independent of viewMode (the totals row's
    // B/E Inven chain needs consistent flows even when the grid view
    // is "ats"). Walk the eventIndex per row + filter to row.store.
    let receiptsVal = 0;
    let cogsVal = 0;
    for (const r of filtered) {
      let v: number | undefined;
      if (viewMode === "ats") {
        v = periodAvail(r, displayPeriods, pi);
      } else if (!r.__collapsed && eventIndex) {
        const skuIdx = eventIndex[r.sku];
        if (skuIdx) {
          let sum = 0;
          const rowStore = r.store;
          for (const date of Object.keys(skuIdx)) {
            if (date < p.periodStart || date > p.endDate) continue;
            const list = viewMode === "so" ? skuIdx[date].sos : skuIdx[date].pos;
            for (const e of list) {
              if (rowStore && (e.store ?? "ROF") !== rowStore) continue;
              sum += e.qty || 0;
            }
          }
          v = sum;
        } else {
          v = 0;
        }
      }
      if (v == null) continue;
      q += v;
      const res = resolved.get(r.sku);
      if (!res) { if (v !== 0) skipped++; continue; }
      c += v * res.cost;
      s += v * res.sale;

      // Receipts + COGS pass — always run from eventIndex regardless of
      // viewMode so the B/E Inven chain doesn't drift between view
      // modes. Skip collapsed rows (no children should double-count).
      if (eventIndex && !r.__collapsed) {
        const skuIdx = eventIndex[r.sku];
        if (skuIdx) {
          const rowStore = r.store;
          for (const date of Object.keys(skuIdx)) {
            if (date < p.periodStart || date > p.endDate) continue;
            for (const po of skuIdx[date].pos) {
              if (rowStore && (po.store ?? "ROF") !== rowStore) continue;
              receiptsVal += (po.qty || 0) * res.cost;
            }
            for (const so of skuIdx[date].sos) {
              if (rowStore && (so.store ?? "ROF") !== rowStore) continue;
              cogsVal += (so.qty || 0) * res.cost;
            }
          }
        }
      }
    }
    periodQty[p.key] = q;
    periodCost[p.key] = c;
    periodSale[p.key] = s;
    periodSkipped[p.key] = skipped;
    periodReceiptsValue[p.key] = receiptsVal;
    periodCogsValue[p.key] = cogsVal;
  }

  return {
    onHand: { qty: onHandQty, cost: onHandCost, sale: onHandSale, skipped: onHandSkipped },
    onOrder: { qty: onOrderQty, cost: onOrderCost, sale: onOrderSale, skipped: onOrderSkipped },
    onPO: { qty: onPOQty, cost: onPOCost, sale: onPOSale, skipped: onPOSkipped },
    periodQty,
    periodCost,
    periodSale,
    periodSkipped,
    periodReceiptsValue,
    periodCogsValue,
  };
}
