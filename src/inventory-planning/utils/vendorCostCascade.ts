// src/inventory-planning/utils/vendorCostCascade.ts
//
// Vendor-first unit-cost cascade for the wholesale planning grid.
//
// CEO ask: the company buys the same style from multiple vendors at different
// true costs (e.g. RYB0185PPK camo: one vendor $121.20/pack, another
// $122.16/pack). When the planner selects a VENDOR on a build, populated costs
// become vendor-based:
//   1. Cost from any OPEN POs matching style/color for THIS vendor.
//   2. Else the most-recent RECEIVED PO (price guide) for this vendor / style /
//      color.
//   3. Else the existing avg cascade (direct avg -> sibling avg).
//   4. Else the existing grain-aware any-vendor open-PO fallback.
// When NO vendor is selected, cost wiring stays EXACTLY as it is today — the
// wrapper falls straight through to cascadePlanningCostForItem, byte-for-byte.
//
// This module is PURE (no IO). The service pre-builds the vendor-scoped PO cost
// rows (already shaped as PoCostRow, with pack_size resolved the same way the
// grid resolves it) and this module re-grains them onto each row using the
// EXACT same base-color -> style tiering + pack re-grain math the existing
// open-PO fallback uses (poFallbackCostForRow). Tier 1 (open) is a qty-weighted
// per-each average; tier 2 (received) is the MOST RECENT per-each cost — a
// price guide, not an average.

import {
  buildPoEachCostByBaseColor,
  buildPoEachCostByStyle,
  poFallbackCostForRow,
  resolvePackSize,
  cascadePlanningCostForItem,
  baseColorKey,
  styleKey,
  type PoCostRow,
  type PlanningCostMaps,
} from "./poCostFallback";

const POSITIVE = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

// One vendor-scoped PO cost line. Extends the shared PoCostRow (sku_code,
// unit_cost, qty_open, pack_size — pack_size already resolved) with the
// received-price-guide inputs. is_open marks a line still awaiting receipt
// (tier 1); is_received + order_date drive the most-recent received cost
// (tier 2).
export interface VendorPoCostRow extends PoCostRow {
  qty_received: number | null;
  is_open: boolean;
  is_received: boolean;
  // ISO date (YYYY-MM-DD) or null. Used only to pick the MOST RECENT received
  // cost; null sorts oldest so a dated row always wins over an undated one.
  order_date: string | null;
}

// The pre-built vendor tiers the grid consumes. openBy* is a qty-weighted
// per-each average (tier 1); recvBy* is the most-recent per-each cost (tier 2).
// Base-color maps are tried before style maps inside poFallbackCostForRow.
export interface VendorCostMaps {
  openByBaseColor: Map<string, number>;
  openByStyle: Map<string, number>;
  recvByBaseColor: Map<string, number>;
  recvByStyle: Map<string, number>;
}

// Most-recent PER-EACH cost bucketed by keyFn(sku_code). Each row's per-each
// cost is unit_cost / pack_size; whichever row has the latest order_date wins
// the bucket (a null date sorts oldest). Rows with a non-positive cost are
// skipped. This is the tier-2 "price guide" — the latest received unit cost,
// NOT a weighted average.
function buildMostRecentPoEachBy(
  rows: VendorPoCostRow[],
  keyFn: (sku: string | null | undefined) => string,
): Map<string, number> {
  const best = new Map<string, { date: string; perEach: number }>();
  for (const r of rows) {
    if (!POSITIVE(r.unit_cost)) continue;
    const packSize = POSITIVE(r.pack_size) ? r.pack_size : 1;
    const perEach = r.unit_cost / packSize;
    if (!POSITIVE(perEach)) continue;
    const key = keyFn(r.sku_code);
    if (!key) continue;
    // "" sorts before any real ISO date, so a dated row always beats an
    // undated one, and among dated rows the lexicographically-largest
    // (latest) ISO date wins.
    const date = r.order_date ?? "";
    const cur = best.get(key);
    if (!cur || date >= cur.date) best.set(key, { date, perEach });
  }
  const out = new Map<string, number>();
  for (const [k, { perEach }] of best) out.set(k, perEach);
  return out;
}

// Split the vendor's PO cost rows into the four tier maps. Open lines feed the
// qty-weighted per-each average (reusing the shared open-PO builders); received
// lines feed the most-recent-cost price guide. A vendor whose rows are all open
// (or all received) simply yields empty maps for the other tier — the cascade
// falls through, never blocks.
export function buildVendorCostMaps(rows: VendorPoCostRow[]): VendorCostMaps {
  const openRows = rows.filter((r) => r.is_open);
  const recvRows = rows.filter((r) => r.is_received);
  return {
    openByBaseColor: buildPoEachCostByBaseColor(openRows),
    openByStyle: buildPoEachCostByStyle(openRows),
    recvByBaseColor: buildMostRecentPoEachBy(recvRows, baseColorKey),
    recvByStyle: buildMostRecentPoEachBy(recvRows, styleKey),
  };
}

// THE vendor-aware planning-grid cost cascade for one resolved item-master row.
// When vendorMaps is non-null, tries the two vendor tiers first (open weighted
// avg, then most-recent received), each re-grained to the row's pack size via
// the shared poFallbackCostForRow; on a miss it falls through to the existing
// cascadePlanningCostForItem (tier 3 avg, tier 4 any-vendor open-PO). When
// vendorMaps is null the call is IDENTICAL to cascadePlanningCostForItem —
// the no-vendor path is unchanged.
export function cascadeVendorAwareCostForItem(
  item: { sku_code?: string | null; pack_size?: number | null } | null | undefined,
  maps: PlanningCostMaps,
  vendorMaps: VendorCostMaps | null,
): number | null {
  if (item?.sku_code && vendorMaps) {
    const rowPackSize = resolvePackSize(item.sku_code, item.pack_size ?? null, maps.prepackUnitsPerPack);
    const t1 = poFallbackCostForRow(item.sku_code, rowPackSize, vendorMaps.openByBaseColor, vendorMaps.openByStyle);
    if (t1 != null) return t1;
    const t2 = poFallbackCostForRow(item.sku_code, rowPackSize, vendorMaps.recvByBaseColor, vendorMaps.recvByStyle);
    if (t2 != null) return t2;
  }
  return cascadePlanningCostForItem(item, maps);
}
