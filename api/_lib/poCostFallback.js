// api/_lib/poCostFallback.js
//
// Server-side port of the wholesale planning grid's open-PO cost fallback
// (src/inventory-planning/utils/poCostFallback.ts). PR #1852 fixed the grid so
// a TBD stock-buy row resolves its Unit Cost through a shared cascade; the
// buy-plan -> PO push (handler h601, buyPlanToPo.js) must cost its PO lines the
// SAME way, or a half-provisioned colorway (all costs NULL, pack_size=1)
// silently pushes a $0 line. This is the pure key/regrain math those tiers
// need — kept in lock-step with the TS (change one, change the other).
//
// Only the functions the push consumes are ported (baseColorKey, styleKey,
// ppkStyleKeyOf, resolvePackSize, buildPoEachCostByBaseColor,
// buildPoEachCostByStyle, poFallbackCostForRow). The sibling-color avg tier is
// derived in buyPlanToPo.js itself from the items it already loads.

import { canonSku, SIZE_SUFFIX_RE } from "./sku-canon.js";

const POSITIVE = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

// Canonical BASE-COLOR key: strip the trailing size suffix (incl. a
// `-PPK24`-style suffix) AND any glued `PPK`/`PPK<n>` token in the style
// portion, leaving `<style>-<color>`. Groups a PO on `RYB0412PPK-BLACK`
// (or `RYB0412-BLACK-PPK24`) onto the each-grain `RYB0412-BLACK` row.
export function baseColorKey(sku) {
  let s = canonSku(sku);
  if (!s) return s;
  // 1. trailing size suffix (also catches a `-PPK<n>` size suffix form).
  s = s.replace(SIZE_SUFFIX_RE, "");
  // 2. glued PPK token in the style portion — `RYB0412PPK-BLACK` →
  //    `RYB0412-BLACK`, and bare `RYB0412PPK` → `RYB0412`.
  s = s.replace(/PPK\d*(?=-|$)/g, "");
  return s;
}

// Canonical STYLE key: the base style with the COLOR segment stripped (one
// tier above baseColorKey). Groups a PO on ANY color of a style onto the
// single style bucket, letting a color with no PO of its own inherit a
// sibling color's PO cost.
export function styleKey(sku) {
  const base = baseColorKey(sku);
  if (!base) return base;
  const dash = base.indexOf("-");
  return dash > 0 ? base.slice(0, dash) : base;
}

// The prepack-matrix lookup key for a SKU: the style portion (everything
// before the first dash, or the whole SKU when there is no dash),
// lowercased — matches the prepack_matrices.ppk_style_code keys (which the
// handler lowercases when building the units-per-pack map).
export function ppkStyleKeyOf(sku) {
  const s = canonSku(sku);
  if (!s) return "";
  const dash = s.indexOf("-");
  return (dash > 0 ? s.slice(0, dash) : s).toLowerCase();
}

// Resolve a SKU's pack size: prefer the active prepack matrix (keyed by
// lowercased ppk style code), then the item-master pack_size column, else 1.
// Only values > 1 count as a real pack size.
export function resolvePackSize(sku, itemPackSize, prepackUnitsPerPack) {
  const key = ppkStyleKeyOf(sku);
  const fromMatrix = key && prepackUnitsPerPack ? prepackUnitsPerPack.get(key) : undefined;
  if (POSITIVE(fromMatrix) && fromMatrix > 1) return fromMatrix;
  if (POSITIVE(itemPackSize) && itemPackSize > 1) return itemPackSize;
  return 1;
}

// Shared accumulator: weighted-average PER-EACH open-PO cost bucketed by
// keyFn(sku_code). Each PO's per-each cost is poUnitCost / poPackSize; the
// average is weighted by qty_open. Rows with a non-positive cost or qty are
// skipped. Each PoCostRow is { sku_code, unit_cost, qty_open, pack_size }
// where pack_size is the already-resolved pack size for THIS PO's sku.
function buildPoEachCost(rows, keyFn) {
  const acc = new Map();
  for (const r of rows || []) {
    if (!POSITIVE(r.unit_cost)) continue;
    const qty = typeof r.qty_open === "number" ? r.qty_open : 0;
    if (!POSITIVE(qty)) continue;
    const packSize = POSITIVE(r.pack_size) ? r.pack_size : 1;
    const perEach = r.unit_cost / packSize;
    if (!POSITIVE(perEach)) continue;
    const key = keyFn(r.sku_code);
    if (!key) continue;
    const a = acc.get(key) || { num: 0, den: 0 };
    a.num += perEach * qty;
    a.den += qty;
    acc.set(key, a);
  }
  const out = new Map();
  for (const [k, { num, den }] of acc) {
    if (den > 0) out.set(k, num / den);
  }
  return out;
}

// Weighted-average PER-EACH open-PO cost keyed by BASE-COLOR.
export function buildPoEachCostByBaseColor(rows) {
  return buildPoEachCost(rows, baseColorKey);
}

// Weighted-average PER-EACH open-PO cost keyed by STYLE (color stripped) —
// aggregated ACROSS all colors of a style so a color with no PO of its own
// can inherit a sibling color's PO cost. Strictly-lower tier than the
// base-color map (see poFallbackCostForRow).
export function buildPoEachCostByStyle(rows) {
  return buildPoEachCost(rows, styleKey);
}

// Re-grain an open-PO per-each cost to a specific line, trying tiers in order
// of specificity: (1) the line's exact BASE-COLOR bucket (this color's own
// PO), then (2) the line's STYLE bucket (any color of the style) when a
// style-level map is supplied. Whichever tier hits, the per-each cost is
// re-grained by the line's pack size (each-grain → per-each; pack-grain →
// pack price). Returns null when neither tier has a cost.
export function poFallbackCostForRow(rowSku, rowPackSize, poEachByBaseColor, poEachByStyle) {
  const packSize = POSITIVE(rowPackSize) ? rowPackSize : 1;
  const colorKey = baseColorKey(rowSku);
  if (colorKey && poEachByBaseColor) {
    const perEach = poEachByBaseColor.get(colorKey);
    if (POSITIVE(perEach)) return perEach * packSize;
  }
  if (poEachByStyle) {
    const sKey = styleKey(rowSku);
    if (sKey) {
      const perEach = poEachByStyle.get(sKey);
      if (POSITIVE(perEach)) return perEach * packSize;
    }
  }
  return null;
}
