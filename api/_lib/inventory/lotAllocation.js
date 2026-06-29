// api/_lib/inventory/lotAllocation.js
//
// Lot numbers — Scenario 5: lot-aware allocation rule for ship-from-stock SOs.
//
// Given the quantity needed for one SKU and that SKU's available stock broken
// down BY LOT, decide which lot(s) to draw from, following the operator's rule:
//
//   1. First try to fill the WHOLE quantity from a SINGLE lot.
//   2. If no single lot can cover it, take the MOST possible from one lot
//      (the largest-available lot), then try to COMPLETE the remainder from a
//      single lot that can finish it.
//   3. Keep going until 100% filled, or report the shortfall (what can't be
//      filled) so the caller can warn the operator (accept / cancel).
//
// The intent is to ship from as FEW lots as possible — ideally one — and to
// keep large lots intact when a smaller lot can do the job. Pure + deterministic
// so it unit-tests cleanly and the endpoint stays a thin wrapper.

/**
 * @typedef {Object} LotBucket
 * @property {string|null} lot_number  the lot id; null = unlotted on-hand
 * @property {number} available        units available in this lot (>= 0)
 */

/**
 * @typedef {Object} LotPick
 * @property {string|null} lot_number
 * @property {number} qty             units drawn from this lot
 */

/**
 * Allocate `qty` across the given lot buckets per the Scenario-5 rule.
 *
 * @param {number} qty                 units needed (rounded down to an integer; <=0 → empty plan)
 * @param {LotBucket[]} lots           available stock by lot
 * @returns {{ picks: LotPick[], filled: number, shortfall: number }}
 */
export function allocateByLot(qty, lots) {
  const need = Math.max(0, Math.floor(Number(qty) || 0));
  // Deterministic working set: drop empty buckets, integer-floor availability,
  // and sort by available DESC then lot_number ASC (null lot sorts last) so the
  // "largest lot" and "smallest sufficient" scans are stable run-to-run.
  const avail = (Array.isArray(lots) ? lots : [])
    .map((l) => ({ lot_number: l.lot_number ?? null, available: Math.max(0, Math.floor(Number(l.available) || 0)) }))
    .filter((l) => l.available > 0)
    .sort((a, b) =>
      b.available - a.available ||
      String(a.lot_number ?? "￿").localeCompare(String(b.lot_number ?? "￿")));

  const picks = [];
  let remaining = need;

  const take = (i, n) => {
    picks.push({ lot_number: avail[i].lot_number, qty: n });
    avail[i].available -= n;
    remaining -= n;
    if (avail[i].available <= 0) avail.splice(i, 1);
  };

  while (remaining > 0 && avail.length > 0) {
    // Prefer to finish from a SINGLE lot — the smallest lot that still covers
    // the outstanding remainder (least leftover, keeps bigger lots whole). On
    // the first pass with a single sufficient lot this IS the "all from one lot"
    // case; on later passes it's the "next lot that can complete the order".
    let best = -1;
    for (let i = 0; i < avail.length; i++) {
      if (avail[i].available >= remaining && (best < 0 || avail[i].available < avail[best].available)) best = i;
    }
    if (best >= 0) { take(best, remaining); break; }
    // No single lot can finish it — take the most possible from one lot (the
    // largest, which sits at index 0 after the sort) and loop.
    take(0, avail[0].available);
  }

  return { picks, filled: need - remaining, shortfall: remaining };
}

/**
 * Roll a flat list of inventory_layers rows into per-lot buckets for one item.
 * `lot_number = null` layers (legacy / pre-lot stock) collapse into a single
 * unlotted bucket so ship-from-stock can still draw on them.
 *
 * @param {{ lot_number: string|null, remaining_qty: number|string }[]} layers
 * @returns {LotBucket[]}
 */
export function bucketsFromLayers(layers) {
  const byLot = new Map();
  for (const l of layers || []) {
    const key = l.lot_number ?? null;
    const q = Number(l.remaining_qty) || 0;
    if (q <= 0) continue;
    byLot.set(key, (byLot.get(key) || 0) + q);
  }
  return [...byLot.entries()].map(([lot_number, available]) => ({ lot_number, available }));
}
