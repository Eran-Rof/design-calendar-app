// Distribute a color-grain total across sizes so the By Size Matrix reconciles
// to the (correct) main ATS report exactly.
//
// WHY: the main report's per-color ATS is netted against the color-grain Xoro
// On Order and uses the ATS inventory-snapshot scope — neither of which is
// available at size grain. So we can't compute size-level ATS independently
// and have it tie out. Instead we take the main report's already-correct
// per-color (and per-period) ATS total and split it across sizes in proportion
// to a size SHAPE (the size-grain on-hand / incoming mix from
// /api/internal/ats-size-matrix). The split is the best size estimate; the
// TOTAL is exact.

/**
 * Split `total` across `sizes` proportional to `shape` weights, returning
 * whole units that sum to EXACTLY `total` (largest-remainder rounding).
 *
 * - total ≤ 0 → empty (no row contribution).
 * - all-zero shape but total > 0 → even split across `sizes` (fallback for a
 *   color with no on-hand/incoming size signal, e.g. a brand-new PO color).
 * - sizes is the ordered scale; weights for sizes not in `shape` count as 0.
 */
export function distribute(
  total: number,
  shape: Record<string, number>,
  sizes: string[],
): Record<string, number> {
  const t = Math.round(Number(total) || 0);
  if (t <= 0 || sizes.length === 0) return {};
  const weights = sizes.map((s) => Math.max(0, Number(shape?.[s]) || 0));
  const W = weights.reduce((a, b) => a + b, 0);

  const out: Record<string, number> = {};
  if (W <= 0) {
    // Even split — deterministic, front-loaded remainder.
    const base = Math.floor(t / sizes.length);
    let rem = t - base * sizes.length;
    for (const s of sizes) { const add = rem > 0 ? 1 : 0; rem -= add; const v = base + add; if (v > 0) out[s] = v; }
    return out;
  }

  const parts = sizes.map((s, i) => {
    const exact = (t * weights[i]) / W;
    return { s, floor: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let assigned = 0;
  for (const p of parts) { if (p.floor > 0) out[p.s] = p.floor; assigned += p.floor; }
  let rem = t - assigned;
  // Hand out the remainder to the largest fractional parts first.
  const order = [...parts].sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && rem > 0; k++) { out[order[k].s] = (out[order[k].s] || 0) + 1; rem--; }
  return out;
}

/** Sum two size→qty maps (used to fold per-period cells into the snapshot). */
export function addBySize(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + (Number(v) || 0);
  return out;
}
