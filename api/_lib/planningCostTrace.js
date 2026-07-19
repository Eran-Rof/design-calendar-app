// api/_lib/planningCostTrace.js
//
// Pure helpers for the read-only planning cost-trace diagnostic
// (api/_handlers/internal/planning/cost-trace.js). Extracted so the
// summary/notes logic — the part that turns raw DB rows into a
// human-readable "why is Unit Cost blank" verdict — is unit-testable
// without a live DB.
//
// The wholesale grid's unit-cost cascade (wholesaleForecastService.ts +
// costResolution.ts + poCostFallback.ts) resolves a row's cost as:
//   direct avg (ip_item_avg_cost) → sibling avg (same style) →
//   exact-sku open PO → base-color open-PO fallback →
//   style-level open-PO fallback → null.
// A blank cost means every link returned nothing. These helpers count the
// raw inputs to each link and flag the likely broken one.

const POSITIVE = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

// Given the three raw row sets already fetched from the DB, compute the
// diagnostic counts and a short notes[] array flagging likely causes of a
// blank Unit Cost. Every input defaults to an empty array so a partial
// fetch (one table errored) still produces a usable summary.
//
//   itemMaster: [{ id, sku_code, style_code, unit_cost, pack_size, active }]
//   avgCost:    [{ sku_code, avg_cost, source, updated_at }]
//   openPos:    [{ sku_id, unit_cost, qty_open, channel, source, po_number,
//                  sku_in_item_master }]
export function buildCostTraceSummary({ itemMaster = [], avgCost = [], openPos = [] } = {}) {
  const im = Array.isArray(itemMaster) ? itemMaster : [];
  const av = Array.isArray(avgCost) ? avgCost : [];
  const po = Array.isArray(openPos) ? openPos : [];

  const itemMasterRows = im.length;
  const itemMasterWithUnitCost = im.filter((r) => POSITIVE(r?.unit_cost)).length;
  const avgCostRows = av.length;
  const avgCostWithPositive = av.filter((r) => POSITIVE(r?.avg_cost)).length;
  const openPoRows = po.length;
  const openPoWithPositiveCost = po.filter((r) => POSITIVE(r?.unit_cost)).length;
  const openPoNullCost = po.filter((r) => r?.unit_cost == null).length;
  const openPoNotInItemMaster = po.filter((r) => r?.sku_in_item_master === false).length;
  const openPoPositiveQtyOpen = po.filter((r) => POSITIVE(r?.qty_open)).length;

  const channels = [...new Set(po.map((r) => r?.channel).filter((c) => c != null && c !== ""))];

  const summary = {
    item_master_rows: itemMasterRows,
    item_master_with_unit_cost: itemMasterWithUnitCost,
    avg_cost_rows: avgCostRows,
    avg_cost_with_positive: avgCostWithPositive,
    open_po_rows: openPoRows,
    open_po_with_positive_cost: openPoWithPositiveCost,
    open_po_with_null_cost: openPoNullCost,
    open_po_with_positive_qty_open: openPoPositiveQtyOpen,
    open_po_sku_not_in_item_master: openPoNotInItemMaster,
    open_po_channels: channels,
  };

  const notes = [];

  if (itemMasterRows === 0) {
    notes.push("No ip_item_master rows match this query — the SKU/style is not in the planning item master at all.");
  }
  if (avgCostRows === 0) {
    notes.push("No avg_cost rows for this style — the direct-avg and sibling-avg cascade steps return nothing.");
  } else if (avgCostWithPositive === 0) {
    notes.push(`${avgCostRows} avg_cost row(s) exist but none have a positive avg_cost — the avg cascade yields nothing.`);
  }
  if (openPoNullCost > 0) {
    notes.push(`${openPoNullCost} open PO(s) have a null unit_cost — they contribute nothing to the open-PO cost fallback.`);
  }
  if (openPoNotInItemMaster > 0) {
    notes.push(`${openPoNotInItemMaster} open PO(s) reference a sku_id not in item master → silently dropped by the grid's cost fallback.`);
  }
  if (openPoRows > 0 && openPoWithPositiveCost === 0) {
    notes.push("Open POs exist but none have a positive unit_cost — the base-color/style-level PO fallback yields nothing.");
  }
  if (openPoRows > 0 && openPoPositiveQtyOpen === 0) {
    notes.push("Open POs exist but none have a positive qty_open — the weighted-average PO cost skips zero-qty rows, yielding nothing.");
  }
  if (openPoRows === 0) {
    notes.push("No open POs for this style — the exact-sku/base-color/style-level PO fallback has no rows to work with.");
  }
  if (channels.length === 1) {
    notes.push(`Open POs found only on channel "${channels[0]}".`);
  }
  if (itemMasterWithUnitCost === 0 && avgCostWithPositive === 0 && openPoWithPositiveCost === 0) {
    notes.push("No cost signal anywhere (no master unit_cost, no positive avg_cost, no positive open-PO cost) → Unit Cost will be blank.");
  }

  return { summary, notes };
}
