// src/lib/inventoryAging.ts
// ────────────────────────────────────────────────────────────────────────────
// Pure math for the Inventory Aging report (Tangerine). Mirrors the SQL in
// migration 20261090000000_inventory_aging.sql so the client can re-derive
// per-bucket distribution, weighted-avg age, carrying cost, and velocity from
// raw FIFO layers, and so vitest can lock the math (incl. parity with the ATS
// aged-inventory constants in src/ats/agedInvenMath.ts).
//
// Carrying-cost constants are KEPT identical to ATS: interest 9%/yr on a
// 360-day year; storage $20 / pallet / month at 864 pcs / pallet. ATS computes
// in dollars; here we work in CENTS (the app-wide money unit) — helpers convert
// at the boundary, and the tests assert cents↔dollars parity with ATS.
// ────────────────────────────────────────────────────────────────────────────

export const INTEREST_RATE = 0.09;
export const PALLET_PCS = 864;
export const STORAGE_PER_PALLET_MONTH = 20; // dollars

// Five ascending day cut-offs → six buckets:
//   b1 ≤ 30, b2 ≤ 60, b3 ≤ 90, b4 ≤ 180, b5 ≤ 365, b6 > 365
export const DEFAULT_BUCKET_DAYS = [30, 60, 90, 180, 365] as const;

export const BUCKET_COUNT = 6;

// Human labels for a given set of cut-offs, e.g. [30,60,90,180,365] →
// ["0-30","31-60","61-90","91-180","181-365","365+"].
export function bucketLabels(cutoffs: readonly number[] = DEFAULT_BUCKET_DAYS): string[] {
  const c = cutoffs.slice(0, 5);
  const labels: string[] = [];
  let lo = 0;
  for (let i = 0; i < c.length; i++) {
    labels.push(`${lo === 0 ? 0 : lo + 1}-${c[i]}`);
    lo = c[i];
  }
  labels.push(`${lo + 1}+`);
  return labels;
}

// Bucket index 1..6 for an age (days), given the 5 cut-offs. Matches the SQL
// CASE exactly (≤ cut-off ladder, else top bucket).
export function bucketIndex(ageDays: number, cutoffs: readonly number[] = DEFAULT_BUCKET_DAYS): number {
  const c = cutoffs;
  if (ageDays <= c[0]) return 1;
  if (ageDays <= c[1]) return 2;
  if (ageDays <= c[2]) return 3;
  if (ageDays <= c[3]) return 4;
  if (ageDays <= c[4]) return 5;
  return 6;
}

// Whole days between a received date and the as-of date (as_of - received),
// matching the SQL integer date subtraction. Accepts YYYY-MM-DD or ISO
// timestamps; clamps negatives (future receipts filtered upstream) to 0.
export function ageDays(receivedISO: string, asOfISO: string): number {
  const r = Date.parse((receivedISO || "").slice(0, 10) + "T00:00:00Z");
  const a = Date.parse((asOfISO || "").slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(r) || !Number.isFinite(a)) return 0;
  const d = Math.floor((a - r) / 86400000);
  return d < 0 ? 0 : d;
}

export interface AgingLayer {
  received_at: string;      // ISO date/timestamp
  remaining_qty: number;
  unit_cost_cents: number;
}

export interface BucketDistribution {
  onHandQty: number;
  valueCents: number;
  avgUnitCostCents: number;
  wavgAgeDays: number;
  oldestAgeDays: number;
  bucketQty: number[];      // length 6
  bucketValueCents: number[]; // length 6
}

// Distribute a set of FIFO layers into age buckets as of `asOfISO`. Each layer
// lands whole in the bucket for its own age — this is the core "richer than
// ATS" behaviour (ATS ages a whole SKU off one date). Layers received AFTER the
// as-of date are ignored (as-of semantics).
export function distributeLayers(
  layers: AgingLayer[],
  asOfISO: string,
  cutoffs: readonly number[] = DEFAULT_BUCKET_DAYS,
): BucketDistribution {
  const bucketQty = new Array(BUCKET_COUNT).fill(0);
  const bucketValueCents = new Array(BUCKET_COUNT).fill(0);
  let onHandQty = 0;
  let valueCents = 0;
  let ageWeighted = 0;
  let oldestAgeDays = 0;

  for (const l of layers) {
    const recv = Date.parse((l.received_at || "").slice(0, 10) + "T00:00:00Z");
    const asOf = Date.parse((asOfISO || "").slice(0, 10) + "T00:00:00Z");
    if (Number.isFinite(recv) && Number.isFinite(asOf) && recv > asOf) continue; // future receipt
    const qty = Number(l.remaining_qty) || 0;
    if (qty === 0) continue;
    const age = ageDays(l.received_at, asOfISO);
    const val = qty * (Number(l.unit_cost_cents) || 0);
    const bi = bucketIndex(age, cutoffs) - 1;
    bucketQty[bi] += qty;
    bucketValueCents[bi] += val;
    onHandQty += qty;
    valueCents += val;
    ageWeighted += qty * age;
    if (age > oldestAgeDays) oldestAgeDays = age;
  }

  return {
    onHandQty,
    valueCents,
    avgUnitCostCents: onHandQty > 0 ? valueCents / onHandQty : 0,
    wavgAgeDays: onHandQty > 0 ? ageWeighted / onHandQty : 0,
    oldestAgeDays,
    bucketQty,
    bucketValueCents,
  };
}

export interface CarryingCost {
  intDailyCents: number;
  intMonthlyCents: number;
  intAnnualCents: number;
  stoDailyCents: number;
  stoMonthlyCents: number;
  stoAnnualCents: number;
  carryPct: number;            // (interest+storage annual) / value
  carryPerUnitCents: number;   // (interest+storage annual) / qty
}

// ATS carrying-cost math, in CENTS. Interest on the on-hand value; storage from
// the pallet model on qty. Identical formulas to agedInvenMath.calcAgedCosts,
// only the money unit differs (dollars → cents: storage rate ×100).
export function carryingCost(qty: number, valueCents: number): CarryingCost {
  const intDailyCents = (valueCents * INTEREST_RATE) / 360;
  const intMonthlyCents = (valueCents * INTEREST_RATE) / 12;
  const intAnnualCents = valueCents * INTEREST_RATE;
  const stoMonthlyCents = (qty / PALLET_PCS) * STORAGE_PER_PALLET_MONTH * 100;
  const stoDailyCents = stoMonthlyCents / 30;
  const stoAnnualCents = stoMonthlyCents * 12;
  const carryPct = valueCents > 0 ? (intAnnualCents + stoAnnualCents) / valueCents : 0;
  const carryPerUnitCents = qty > 0 ? (intAnnualCents + stoAnnualCents) / qty : 0;
  return {
    intDailyCents, intMonthlyCents, intAnnualCents,
    stoDailyCents, stoMonthlyCents, stoAnnualCents,
    carryPct, carryPerUnitCents,
  };
}

// Weeks of supply = on-hand / (weekly sell-through). units90 covers a 90-day
// window ≈ 90/7 weeks. 0 sales → null (infinite / no velocity).
export function weeksOfSupply(onHandQty: number, units90: number): number | null {
  if (!units90 || units90 <= 0) return null;
  const weeklyRate = units90 / (90 / 7);
  if (weeklyRate <= 0) return null;
  return onHandQty / weeklyRate;
}

// Days since last sale, as-of. null last-sold → null (never sold).
export function daysSinceLastSale(lastSoldISO: string | null | undefined, asOfISO: string): number | null {
  if (!lastSoldISO) return null;
  return ageDays(lastSoldISO, asOfISO);
}
