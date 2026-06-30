// Pre-pack (PPK) shared utilities — single source of truth for both
// the ATS app and the inventory-planning workbench.
//
// A "prepack" is an inventory item whose Xoro-side qty / cost are
// reported in PACKS rather than units; per-pack unit counts are
// encoded in the SKU/size/description as a "PPKn" token (n = units
// per pack). Both apps need to convert pack-grain qtys to unit-grain
// for any user-facing math (ATS counts, planning forecasts, recon).
//
// Detection: ANY of color / size / description / style / SKU
// containing "PPKn" (case-insensitive, optional space/underscore/dash
// between PPK and the number). The number after PPK is the
// units-per-pack multiplier.
//
// Examples:
//   "PPK24"           → 24
//   "PPK 24"          → 24
//   "PPK-24"          → 24
//   "PPK_24"          → 24
//   "PPK24-Black"     → 24
//   "RYB059430PPK"    → null (no number after PPK)
//   "Tech Jogger PPK24 Special" → 24
//
// Application:
//   - Multiply qty fields (on_hand, on_so, on_po, receipts) by mult
//   - Divide cost fields (avg_cost, item_cost) by mult
//   - Demand fields (forecast / planned buy) stay unchanged — already
//     entered in selling units

/** Extract the PPK multiplier from a single string field. Returns null
 *  when no "PPKn" pattern is present. */
export function extractPpk(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = value.match(/PPK[\s_-]*(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Resolve the units-per-pack multiplier by checking each input field
 *  in order of priority. Returns 1 (no-op) when none match — callers
 *  can multiply qtys / divide costs unconditionally without a guard.
 *
 *  Field-priority order is the planning-grid convention: color first
 *  (most distinctive), size next, then descriptive fallbacks. ATS
 *  passes `null` for the color slot since it doesn't carry a separate
 *  color column, but the same priority chain still applies.
 *
 *  Identity gate: sku, style, OR size must contain "PPK" before we'll
 *  return a multiplier > 1. Size is treated as a valid identity signal
 *  because for older styles (e.g. RCB1510NPT, sold both as eachs and
 *  as prepacks) the prepack-ness is encoded in the size column rather
 *  than the style name. Description is intentionally NOT in the gate:
 *  description is free text and can carry a stray "PPK24" token (cross-
 *  ref note, leakage from master) on a non-prepack row that shares a
 *  style with a prepack — e.g. RYB059430 alongside RYB059430PPK — and
 *  without the gate that row would have its on-hand / on-PO / on-SO
 *  multiplied 24x. */
export function ppkMultiplier(
  color: string | null | undefined,
  size: string | null | undefined,
  description?: string | null,
  style?: string | null,
  sku?: string | null,
): number {
  const skuLooksPpk = !!sku && /PPK/i.test(sku);
  const styleLooksPpk = !!style && /PPK/i.test(style);
  const sizeLooksPpk = !!size && /PPK/i.test(size);
  if (!skuLooksPpk && !styleLooksPpk && !sizeLooksPpk) return 1;
  return (
    extractPpk(color) ??
    extractPpk(size) ??
    extractPpk(description) ??
    extractPpk(style) ??
    extractPpk(sku) ??
    1
  );
}

/** Convenience for ATS-shape rows where SKU and description are the
 *  only fields likely to carry the PPK token. SKU is the canonical
 *  place we'd see "PPK" since the parser folds color into the SKU
 *  string; description is the secondary fallback. Same identity gate
 *  as ppkMultiplier — without "PPK" in the SKU, never multiplies. */
export function ppkMultiplierForAts(
  sku: string | null | undefined,
  description: string | null | undefined,
): number {
  if (!sku || !/PPK/i.test(sku)) return 1;
  return extractPpk(sku) ?? extractPpk(description) ?? 1;
}

// ── Order-entry pack→eaches math ───────────────────────────────────────────
// A prepack is ordered and STORED as a number of PACKS (native pack grain). Each
// pack holds a fixed per-size garment composition defined in the Prepack Matrix
// master (prepack_matrices). The helpers below turn "N packs" into the per-size
// eaches breakdown ("explode") used by SO / PO line entry — pure, no side
// effects. The order line keeps the pack count; this breakdown is for display
// and the size-level explode used downstream.

/** One composition row of a prepack: garment units of `size` in a single pack.
 *  `qty_per_pack` = the carton-pack quantity; `inner_pack_qty` = the inner-pack
 *  quantity (optional — present when the prepack matrix defines it). */
export type PrepackCompositionRow = { size: string; qty_per_pack: number; inner_pack_qty?: number };

/** The order-entry prepack block returned on a PPK style's matrix payload. */
export type PrepackBlock = {
  /** Pack token used as the single entry column (e.g. "PPK24"). */
  pack_token: string;
  /** Units in one pack: Σ qty_per_pack (or the token's digits when no matrix). */
  pack_total: number | null;
  /** Per-size composition (ordered). Empty when no active matrix is defined. */
  composition: PrepackCompositionRow[];
  /** True when an active prepack matrix supplies the composition. */
  has_matrix: boolean;
};

/** Units in one pack = Σ of the (non-negative) per-size quantities. */
export function packTotal(composition: PrepackCompositionRow[]): number {
  return composition.reduce((s, c) => s + (c.qty_per_pack > 0 ? c.qty_per_pack : 0), 0);
}

/**
 * Explode `packs` into per-size eaches via the composition: each size gets
 * `packs × qty_per_pack`. Returns a { size → eaches } map containing only sizes
 * with a positive ratio. `packs ≤ 0` (or an empty composition) yields {}.
 */
export function explodePacks(
  packs: number,
  composition: PrepackCompositionRow[],
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!(packs > 0)) return out;
  for (const c of composition) {
    if (c.qty_per_pack > 0) out[c.size] = packs * c.qty_per_pack;
  }
  return out;
}

/** Total eaches represented by `packs` of a prepack = packs × pack units. */
export function packsToUnits(packs: number, composition: PrepackCompositionRow[]): number {
  if (!(packs > 0)) return 0;
  return packs * packTotal(composition);
}
