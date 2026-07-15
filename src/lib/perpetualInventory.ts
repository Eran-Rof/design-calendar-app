// src/lib/perpetualInventory.ts
//
// Pure helpers for the SHADOW perpetual inventory ledger (Cutover Phase 2).
// They mirror the SQL in migration 20261080000000 (v_inv_perpetual_onhand,
// v_inv_perpetual_reconcile, inv_perpetual_readiness_summary) so the UI can
// re-aggregate / re-score a filtered subset client-side without a round-trip.
// The SQL is the source of truth; this is its faithful, dependency-free twin.
//
// Concepts:
//   * perpetual on-hand = Σ signed qty_delta of the event ledger, per key.
//   * drift vs truth    = perp_qty - rest_qty (Xoro REST by-size = truth).
//   * readiness %       = share of REST-covered SKUs whose perpetual tracks
//                         truth (|drift| < TIE_EPSILON). As event-sourced
//                         movement capture improves, drift -> 0 and % -> 100.

export type MovementType =
  | "opening" | "receipt" | "sale" | "transfer_in" | "transfer_out" | "adjustment" | "return";

// Below this a drift reads as a tie (rounding) — mirror of the SQL threshold.
export const TIE_EPSILON = 0.5;

// Key delimiter: item_id/location_id are UUIDs and size is a short label — none
// contain a pipe, so "|" joins the grain without collisions.
const KEY_SEP = "|";

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? Number(v) : v ?? 0;
  return Number.isFinite(n as number) ? (n as number) : 0;
};

export interface MovementLike {
  item_id?: string | null;
  location_id?: string | null;
  size?: string | null;
  qty_delta: number | string | null;
  movement_type?: MovementType | string | null;
}

/** Build the (item|location|size) grain key for a movement/on-hand row. */
export function perpetualKey(item_id?: string | null, location_id?: string | null, size?: string | null): string {
  return [item_id ?? "", location_id ?? "", size ?? ""].join(KEY_SEP);
}

/**
 * Σ qty_delta grouped by (item_id | location_id | size). Returns a Map keyed
 * by perpetualKey so callers can look up a perpetual on-hand.
 */
export function sumPerpetual(movements: MovementLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of movements) {
    const key = perpetualKey(m.item_id, m.location_id, m.size);
    out.set(key, (out.get(key) ?? 0) + num(m.qty_delta));
  }
  return out;
}

/** Signed drift between perpetual on-hand and a truth quantity. */
export function computeDrift(perpQty: number | string | null, truthQty: number | string | null): number {
  return num(perpQty) - num(truthQty);
}

/** True when the perpetual tracks truth within the tie epsilon. */
export function tracksTruth(perpQty: number | string | null, truthQty: number | string | null): boolean {
  return Math.abs(computeDrift(perpQty, truthQty)) < TIE_EPSILON;
}

export interface ReconcileRowLike {
  perp_qty: number | string | null;
  rest_qty: number | string | null;
  rest_covered?: boolean | null;
  abs_drift_vs_truth?: number | string | null;
  drift_value_cents?: number | string | null;
  size_grain_known?: boolean | null;
}

export interface ReadinessRollup {
  skusTotal: number;
  skusCoveredTruth: number;   // appear in the REST truth feed
  skusTrackingTruth: number;  // |drift| < epsilon
  readinessPct: number;       // 0..100, over REST-covered SKUs
  sumAbsDriftVsTruth: number;
  driftValueCents: number;
  skusSizeFlagged: number;
}

/**
 * Roll a set of reconciliation rows up to the readiness scorecard. Readiness
 * is measured over REST-covered SKUs only (a SKU absent from truth cannot be
 * scored). Mirrors inv_perpetual_readiness_summary().
 */
export function summarizeReadiness(rows: ReconcileRowLike[]): ReadinessRollup {
  const r: ReadinessRollup = {
    skusTotal: 0, skusCoveredTruth: 0, skusTrackingTruth: 0, readinessPct: 0,
    sumAbsDriftVsTruth: 0, driftValueCents: 0, skusSizeFlagged: 0,
  };
  for (const row of rows) {
    r.skusTotal += 1;
    const covered = Boolean(row.rest_covered);
    if (covered) r.skusCoveredTruth += 1;
    const abs = row.abs_drift_vs_truth != null
      ? num(row.abs_drift_vs_truth)
      : Math.abs(computeDrift(row.perp_qty, row.rest_qty));
    if (covered && abs < TIE_EPSILON) r.skusTrackingTruth += 1;
    r.sumAbsDriftVsTruth += abs;
    r.driftValueCents += num(row.drift_value_cents);
    if (row.size_grain_known === false) r.skusSizeFlagged += 1;
  }
  r.readinessPct = r.skusCoveredTruth > 0
    ? Math.round((1000 * r.skusTrackingTruth) / r.skusCoveredTruth) / 10
    : 0;
  return r;
}

export interface CoverageLike {
  movement_type?: MovementType | string | null;
  size_grain_known?: boolean | null;
}

export interface CoverageRollup {
  movementsTotal: number;
  movementsOpening: number;
  movementsIncremental: number;   // everything that is not the opening seed
  movementsSizeFlagged: number;
  byType: Record<string, number>;
}

/**
 * Coverage of the ledger by movement type + how much is size-grain vs flagged.
 * The "incremental" count (non-opening) is the true measure of event-sourced
 * capture: at t0 it is tiny (receipts only); at cutover it grows as sale
 * depletion / transfers / adjustments start flowing.
 */
export function summarizeCoverage(movements: CoverageLike[]): CoverageRollup {
  const byType: Record<string, number> = {};
  let opening = 0, sizeFlagged = 0;
  for (const m of movements) {
    const t = String(m.movement_type ?? "unknown");
    byType[t] = (byType[t] ?? 0) + 1;
    if (t === "opening") opening += 1;
    if (m.size_grain_known === false) sizeFlagged += 1;
  }
  const total = movements.length;
  return {
    movementsTotal: total,
    movementsOpening: opening,
    movementsIncremental: total - opening,
    movementsSizeFlagged: sizeFlagged,
    byType,
  };
}

/** Share (0..100) of movements captured at true by-size grain. */
export function sizeGrainCoveragePct(cov: CoverageRollup): number {
  if (cov.movementsTotal === 0) return 0;
  const known = cov.movementsTotal - cov.movementsSizeFlagged;
  return Math.round((1000 * known) / cov.movementsTotal) / 10;
}
