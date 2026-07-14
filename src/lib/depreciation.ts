// src/lib/depreciation.ts
//
// Pure fixed-asset depreciation engine (no I/O, no GL). Produces the full
// monthly depreciation schedule for an asset under any of four methods:
//   • straight_line
//   • declining_balance_200  (double-declining, 200% factor, SL switch-over)
//   • declining_balance_150  (150% declining, SL switch-over)
//   • units_of_production    (requires per-period usage)
//
// ── Conventions (documented, deterministic) ─────────────────────────────────
// MID-MONTH (half-month) convention for the time-based methods: the month the
// asset is placed in service earns HALF a period of depreciation, every whole
// month thereafter earns a full period, and a final HALF period lands in the
// month after the useful life elapses. The schedule therefore spans
// useful_life_months + 1 calendar months and the period weights sum to exactly
// useful_life_months — so total depreciation equals the depreciable base
// (cost − salvage) to the cent.
//
// DECLINING BALANCE applies factor/life as a monthly rate to the *opening book
// value* each period (weighted by the period fraction) and automatically
// SWITCHES OVER to straight-line across the remaining periods once SL yields a
// larger charge. This guarantees the asset is fully depreciated to salvage by
// the end of its useful life while preserving the accelerated early curve.
// Book value never drops below salvage.
//
// UNITS OF PRODUCTION ignores the calendar convention: each period's charge is
// (base × units_this_period / units_total), capped so accumulated never exceeds
// the base. It requires a usage series (unitsByPeriod).
//
// DISPOSAL: if a disposal date is supplied, the schedule is truncated to
// periods on or before the disposal month; the caller computes gain/loss from
// proceeds − net book value. This engine posts nothing.
//
// All amounts are INTEGER CENTS. Rounding drift is eliminated by tracking a
// rounded cumulative target and taking each period as the delta, so the final
// period absorbs any remainder and accumulated ties exactly.

export type DepreciationMethod =
  | "straight_line"
  | "declining_balance_200"
  | "declining_balance_150"
  | "units_of_production";

export interface DepreciationAssetInput {
  acquisition_cost_cents: number;
  salvage_value_cents?: number | null;
  useful_life_months: number;
  method?: DepreciationMethod | string | null;
  /** Placed-in-service date (YYYY-MM-DD). Falls back to depreciation_start / acquisition_date. */
  in_service_date?: string | null;
  depreciation_start?: string | null;
  acquisition_date?: string | null;
  /** For units_of_production: total expected lifetime units. */
  units_total?: number | null;
  /** Optional disposal date (YYYY-MM-DD) — schedule truncated to this month. */
  disposed_date?: string | null;
}

export interface ScheduleRow {
  /** Month-end date, YYYY-MM-DD. */
  period_date: string;
  depreciation_cents: number;
  accumulated_cents: number;
  book_value_cents: number;
}

const DB_FACTOR: Record<string, number> = {
  declining_balance_200: 2.0,
  declining_balance_150: 1.5,
};

/** Last calendar day of (year, monthIdx0) as YYYY-MM-DD (UTC). */
function monthEndISO(year: number, monthIdx0: number): string {
  return new Date(Date.UTC(year, monthIdx0 + 1, 0)).toISOString().slice(0, 10);
}

/** YYYY-MM(-DD) → {y, m0}. Returns null on garbage. */
function parseYearMonth(s: string | null | undefined): { y: number; m0: number } | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const m0 = Number(m[2]) - 1;
  if (!Number.isFinite(y) || m0 < 0 || m0 > 11) return null;
  return { y, m0 };
}

function inServiceOf(a: DepreciationAssetInput): string | null {
  return a.in_service_date || a.depreciation_start || a.acquisition_date || null;
}

/**
 * Period weights under the mid-month convention for a given useful life.
 * length = life + 1; sum = life. First & last = 0.5, middle = 1.0.
 * For life === 1 → [0.5, 0.5].
 */
export function midMonthWeights(life: number): number[] {
  if (life <= 0) return [];
  const w: number[] = [0.5];
  for (let i = 1; i < life; i++) w.push(1);
  w.push(0.5);
  return w;
}

/** cents helper — round to nearest integer cent. */
const r = (n: number) => Math.round(n);

/**
 * Build the full monthly depreciation schedule for an asset.
 *
 * @param unitsByPeriod  units_of_production only — array of per-period unit
 *   counts starting at the in-service month (index 0). Ignored otherwise.
 */
export function buildSchedule(
  asset: DepreciationAssetInput,
  unitsByPeriod?: number[],
): ScheduleRow[] {
  const cost = Math.max(0, Math.round(Number(asset.acquisition_cost_cents) || 0));
  const salvage = Math.max(0, Math.round(Number(asset.salvage_value_cents) || 0));
  const life = Math.round(Number(asset.useful_life_months) || 0);
  const base = Math.max(0, cost - salvage);
  const method = String(asset.method || "straight_line");
  const start = parseYearMonth(inServiceOf(asset));
  if (base <= 0 || life <= 0 || !start) return [];

  const disposal = parseYearMonth(asset.disposed_date);
  const rows: ScheduleRow[] = [];
  let accum = 0;

  // ── units_of_production ────────────────────────────────────────────────
  if (method === "units_of_production") {
    const total = Math.round(Number(asset.units_total) || 0);
    const usage = unitsByPeriod || [];
    if (total <= 0 || usage.length === 0) return [];
    let cumUnits = 0;
    for (let i = 0; i < usage.length && accum < base; i++) {
      const u = Math.max(0, Number(usage[i]) || 0);
      cumUnits += u;
      // Rounded cumulative target caps at base.
      const target = Math.min(base, r((base * Math.min(cumUnits, total)) / total));
      const dep = target - accum;
      if (dep <= 0) continue;
      const y = start.y + Math.floor((start.m0 + i) / 12);
      const m0 = (start.m0 + i) % 12;
      accum = target;
      rows.push({
        period_date: monthEndISO(y, m0),
        depreciation_cents: dep,
        accumulated_cents: accum,
        book_value_cents: cost - accum,
      });
    }
    return truncateAtDisposal(rows, disposal, cost);
  }

  // ── time-based methods (SL + declining balance) ────────────────────────
  const weights = midMonthWeights(life);
  const totalW = weights.reduce((s, x) => s + x, 0); // === life
  const dbFactor = DB_FACTOR[method]; // undefined for straight_line
  const dbMonthlyRate = dbFactor ? dbFactor / life : 0;

  let cumW = 0;
  for (let i = 0; i < weights.length && accum < base; i++) {
    const w = weights[i];
    const remainingW = totalW - cumW; // weight left including this period
    cumW += w;

    let dep: number;
    if (!dbFactor) {
      // Straight-line via rounded cumulative target (no drift).
      const target = Math.min(base, r((base * cumW) / totalW));
      dep = target - accum;
    } else {
      // Declining balance on opening book value, with SL switch-over.
      const book = cost - accum;
      const rem = book - salvage; // depreciable remainder
      if (rem <= 0) break;
      const dbDep = book * dbMonthlyRate * w;
      const slDep = remainingW > 0 ? (rem * w) / remainingW : rem;
      dep = Math.min(rem, Math.max(dbDep, slDep));
      dep = r(dep);
      if (dep > rem) dep = rem;
    }
    if (dep <= 0) continue;

    const y = start.y + Math.floor((start.m0 + i) / 12);
    const m0 = (start.m0 + i) % 12;
    accum += dep;
    if (accum > base) { dep -= accum - base; accum = base; }
    rows.push({
      period_date: monthEndISO(y, m0),
      depreciation_cents: dep,
      accumulated_cents: accum,
      book_value_cents: cost - accum,
    });
  }

  return truncateAtDisposal(rows, disposal, cost);
}

/** Drop schedule rows after the disposal month (inclusive of the disposal month). */
function truncateAtDisposal(
  rows: ScheduleRow[],
  disposal: { y: number; m0: number } | null,
  cost: number,
): ScheduleRow[] {
  if (!disposal) return rows;
  const cutoff = monthEndISO(disposal.y, disposal.m0);
  const kept = rows.filter((row) => row.period_date <= cutoff);
  // Recompute accumulated/book on the kept slice (already correct since prefix).
  let accum = 0;
  for (const row of kept) {
    accum += row.depreciation_cents;
    row.accumulated_cents = accum;
    row.book_value_cents = cost - accum;
  }
  return kept;
}

/** Simple straight-line monthly amount (floor) — for the register list display. */
export function monthlyStraightLineCents(asset: DepreciationAssetInput): number {
  const base = Math.max(0, (Number(asset.acquisition_cost_cents) || 0) - (Number(asset.salvage_value_cents) || 0));
  const life = Number(asset.useful_life_months) || 0;
  return life > 0 ? Math.floor(base / life) : 0;
}

/** Gain/loss on disposal = proceeds − net book value (positive = gain). */
export function disposalGainLossCents(costCents: number, accumulatedCents: number, proceedsCents: number): number {
  const nbv = Math.max(0, (Number(costCents) || 0) - (Number(accumulatedCents) || 0));
  return (Number(proceedsCents) || 0) - nbv;
}
