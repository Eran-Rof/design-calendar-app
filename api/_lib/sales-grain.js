// Sales-history grain helpers — shared by every path that writes to
// ip_sales_history_wholesale. Xoro records prepack sales at either
// pack-count or unit-count grain per row, and there's no UOM column in
// the InvoiceDetail report to disambiguate after the fact. We infer
// grain from PPK tokens in the raw Item Number BEFORE
// canonStyleColor strips them, then store the inferred grain + the
// derived unit-grain qty + cogs + margin on every row.
//
// Migrations:
//   20260517230000_sales_history_grain_and_margin.sql — adds qty_grain,
//     qty_units, unit_cost_at_sale, margin_amount, margin_pct columns +
//     backfill.
//   20260518000000_sales_history_cogs_and_smart_cost.sql — adds
//     cogs_amount + re-derives cost/margin via the smart-cost rule
//     below (mirror).
//
// This module owns the inference + math. Keep the regex + the cost +
// margin formulas in lockstep with the SQL backfill in those migrations.

const PPK_TOKEN_RE = /(?:^|[^A-Z])PPK\d*(?:[^A-Z0-9]|$)/i;

export function inferQtyGrain(rawItemNumber, packSize) {
  if (!rawItemNumber) return "unit";
  if (!packSize || packSize <= 1) return "unit";
  return PPK_TOKEN_RE.test(String(rawItemNumber)) ? "pack" : "unit";
}

export function toQtyUnits(qty, grain, packSize) {
  const q = Number(qty) || 0;
  const p = Math.max(1, Number(packSize) || 1);
  return grain === "pack" ? q * p : q;
}

export function computeRowMargin({ netAmount, qtyUnits, perUnitCost }) {
  if (netAmount == null || qtyUnits == null || perUnitCost == null) {
    return { amount: null, pct: null };
  }
  const net = Number(netAmount);
  const qu = Number(qtyUnits);
  const cost = Number(perUnitCost);
  if (!Number.isFinite(net) || !Number.isFinite(qu) || !Number.isFinite(cost)) {
    return { amount: null, pct: null };
  }
  if (net <= 0) return { amount: null, pct: null };
  const amount = net - qu * cost;
  const pct = amount / net;
  return { amount, pct };
}

// Resolve a per-unit cost from a master snapshot + the row's grain +
// the row's per-unit sale price. master.unit_cost grain is
// inconsistent across ip_item_master: usually per-pack for true
// prepack-master rows, but per-unit for variant rows under a
// prepack family (and per-unit for non-prepack items).
//
// Rules:
//  1. Pack-grain sale: master.unit_cost is per-pack (Xoro convention),
//     divide by pack_size for per-unit.
//  2. Unit-grain sale: if master.unit_cost > 2 x unit-price, master
//     cost is implausibly high relative to the per-unit sale price
//     and is almost certainly stored at per-pack grain — divide.
//  3. Otherwise master.unit_cost is at per-unit grain; use as-is.
//
// The 2x threshold mirrors the legacy cost-implausibility gate that
// exportExcel.ts used to apply at READ time — moving it to the WRITE
// path so the snapshot persisted on every row is already correct.
export function resolvePerUnitCost({ masterUnitCost, packSize, grain, netAmount, qtyUnits }) {
  if (masterUnitCost == null) return null;
  const cost = Number(masterUnitCost);
  if (!Number.isFinite(cost)) return null;
  const ps = Math.max(1, Number(packSize) || 1);
  if (grain === "pack") return cost / ps;
  if (netAmount != null && qtyUnits > 0) {
    const unitPrice = Number(netAmount) / Number(qtyUnits);
    if (Number.isFinite(unitPrice) && unitPrice > 0 && cost > unitPrice * 2) {
      return cost / ps;
    }
  }
  return cost;
}

export function deriveSalesGrainFields({ rawItemNumber, qty, netAmount, master }) {
  const packSize = Math.max(1, Number(master?.pack_size) || 1);
  const grain = inferQtyGrain(rawItemNumber, packSize);
  const qtyUnits = toQtyUnits(qty, grain, packSize);
  const perUnitCost = resolvePerUnitCost({
    masterUnitCost: master?.unit_cost ?? null,
    packSize,
    grain,
    netAmount,
    qtyUnits,
  });
  const cogsAmount = perUnitCost != null ? qtyUnits * perUnitCost : null;
  const { amount, pct } = computeRowMargin({
    netAmount,
    qtyUnits,
    perUnitCost,
  });
  return {
    qty_grain: grain,
    qty_units: qtyUnits,
    unit_cost_at_sale: perUnitCost,
    cogs_amount: cogsAmount,
    margin_amount: amount,
    margin_pct: pct,
  };
}
