// src/lib/inventoryReconcile.ts
//
// Pure helpers for the Inventory On-Hand Accuracy monitor. These mirror the
// severity/divergence logic baked into the SQL view v_inventory_onhand_reconcile
// (migration 20260997000000) so the UI can re-classify client-side (e.g. after
// a filter) and stay in lock-step with the server. Kept dependency-free and
// unit-tested; the SQL is the source of truth, this is its faithful twin.
//
// Truth basis: the Xoro REST by-size feed (tangerine_size_onhand). Signed
// divergence = layersQty - restQty (positive = the LIVE app OVERSTATES vs REST).

export type Severity = "tie" | "minor" | "material" | "phantom_suspect";

// Thresholds — keep in sync with the CASE in v_inventory_onhand_reconcile.
export const TIE_EPSILON = 0.5;   // |div| below this reads as a tie (rounding)
export const MINOR_MAX = 25;      // |div| at/under this is "minor", else material

export interface DivergenceInput {
  layersQty: number;             // Σ inventory_layers.remaining_qty (live)
  restQty: number | null;        // REST by-size on-hand (truth); null = no REST coverage
  restCovered: boolean;          // whether the SKU appears in the REST feed at all
  hasOpeningResidual?: boolean;  // an opening_balance layer still carries qty (classic phantom)
}

export interface DivergenceResult {
  divergence: number;            // signed: layersQty - (restQty ?? 0)
  absDivergence: number;
  severity: Severity;
  isPhantomSuspect: boolean;
}

const SEVERITY_RANK: Record<Severity, number> = {
  phantom_suspect: 3,
  material: 2,
  minor: 1,
  tie: 0,
};

/** Higher = more concerning. Handy for sorting a grid worst-first. */
export function severityRank(sev: Severity): number {
  return SEVERITY_RANK[sev] ?? 0;
}

/**
 * Classify one SKU's on-hand divergence. Phantom-suspect (app shows stock the
 * REST truth says is gone, or a stale opening_balance seed) outranks pure
 * magnitude; otherwise tie/minor/material by |divergence|.
 */
export function classifyDivergence(input: DivergenceInput): DivergenceResult {
  const layers = Number(input.layersQty) || 0;
  const rest = input.restQty == null ? 0 : Number(input.restQty) || 0;
  const divergence = layers - rest;
  const absDivergence = Math.abs(divergence);

  const isPhantomSuspect = Boolean(
    input.hasOpeningResidual ||
      (layers > 0 && input.restCovered && rest === 0)
  );

  let severity: Severity;
  if (isPhantomSuspect) severity = "phantom_suspect";
  else if (absDivergence < TIE_EPSILON) severity = "tie";
  else if (absDivergence <= MINOR_MAX) severity = "minor";
  else severity = "material";

  return { divergence, absDivergence, severity, isPhantomSuspect };
}

export interface ReconcileRowLike {
  severity: Severity;
  abs_divergence: number | string | null;
  divergence_value_cents: number | string | null;
  is_negative?: boolean | null;
  is_zero_cost?: boolean | null;
}

export interface DivergenceRollup {
  skusTotal: number;
  skusTie: number;
  skusMinor: number;
  skusMaterial: number;
  skusPhantom: number;
  skusDivergent: number;
  sumAbsUnits: number;
  exposureCents: number;
  negativeSkus: number;
  zeroCostSkus: number;
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? Number(v) : v ?? 0;
  return Number.isFinite(n as number) ? (n as number) : 0;
};

/**
 * Roll a set of reconciliation rows up to the scorecard totals. Used by the
 * panel to recompute the summary over a filtered subset without a round-trip.
 */
export function summarizeRows(rows: ReconcileRowLike[]): DivergenceRollup {
  const r: DivergenceRollup = {
    skusTotal: 0, skusTie: 0, skusMinor: 0, skusMaterial: 0, skusPhantom: 0,
    skusDivergent: 0, sumAbsUnits: 0, exposureCents: 0, negativeSkus: 0, zeroCostSkus: 0,
  };
  for (const row of rows) {
    r.skusTotal += 1;
    switch (row.severity) {
      case "tie": r.skusTie += 1; break;
      case "minor": r.skusMinor += 1; break;
      case "material": r.skusMaterial += 1; break;
      case "phantom_suspect": r.skusPhantom += 1; break;
    }
    if (row.severity !== "tie") r.skusDivergent += 1;
    r.sumAbsUnits += num(row.abs_divergence);
    r.exposureCents += num(row.divergence_value_cents);
    if (row.is_negative) r.negativeSkus += 1;
    if (row.is_zero_cost) r.zeroCostSkus += 1;
  }
  return r;
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  tie: "Tie",
  minor: "Minor",
  material: "Material",
  phantom_suspect: "Phantom-suspect",
};
