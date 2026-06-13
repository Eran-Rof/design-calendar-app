// src/shared/sizeScale.ts
//
// Per-style "size scale" pack ratio + the carton-aware distribution math shared
// by Style Master (where the operator defines the pack) and the SO / PO size
// matrices (where typing a single total auto-fills every size).
//
// A pack is a representative per-size quantity, e.g. { S:2, M:3, L:3, XL:2 }.
// Only the RATIO between sizes matters for distribution — the absolute numbers
// are just a convenient way to express it.
//
// Operator rule (locked 2026-06-12): when a total is typed into the matrix Qty
// column it is split across sizes in proportion to the pack, then EACH size is
// rounded UP to the nearest full carton (default 24 units). Sizes with a zero
// pack ratio stay zero. Nothing is rejected, so the resulting grand total can
// land a little above the typed total — that is expected and intentional.

export type SizePack = Record<string, number>;

export const CARTON = 24;

/** Round a count UP to the nearest multiple of `carton`. 0 (or negative) → 0. */
export function ceilToCarton(n: number, carton = CARTON): number {
  if (!(n > 0)) return 0;
  return Math.ceil(n / carton) * carton;
}

/** Sum the (non-negative) pack ratio across the given sizes. */
export function packSum(sizes: string[], pack: SizePack): number {
  return sizes.reduce((s, sz) => s + (pack[sz] > 0 ? pack[sz] : 0), 0);
}

/**
 * Split `total` across `sizes` proportionally to `pack`, then round each size
 * UP to the nearest full carton. Returns a qty for EVERY size in `sizes`
 * (0 where the pack ratio is 0 or the inputs are unusable).
 */
export function distributeByPack(
  total: number,
  sizes: string[],
  pack: SizePack,
  carton = CARTON,
): Record<string, number> {
  const out: Record<string, number> = {};
  const denom = packSum(sizes, pack);
  if (!(total > 0) || denom <= 0) {
    for (const sz of sizes) out[sz] = 0;
    return out;
  }
  for (const sz of sizes) {
    const p = pack[sz] > 0 ? pack[sz] : 0;
    out[sz] = ceilToCarton((total * p) / denom, carton);
  }
  return out;
}

/** True when a qty is a positive non-multiple of the carton size (partial carton). */
export function isPartialCarton(qty: number, carton = CARTON): boolean {
  return qty > 0 && qty % carton !== 0;
}

/** A pack is usable for distribution only if at least one size has a positive ratio. */
export function hasUsablePack(sizes: string[], pack: SizePack | null | undefined): boolean {
  if (!pack) return false;
  return packSum(sizes, pack) > 0;
}
