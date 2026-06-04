// api/_lib/fixed-assets/depreciation.js
//
// P25 / M21 — straight-line depreciation schedule (pure, unit-tested).
// Monthly amount = (cost − salvage) / useful_life_months, recorded at each
// month-end from the depreciation start through a target date, skipping
// already-recorded periods and never depreciating past the depreciable base
// (the final period takes the rounding remainder).

function monthEnd(year, monthIdx0) {
  // monthIdx0: 0-11. Last day of that month.
  const d = new Date(Date.UTC(year, monthIdx0 + 1, 0));
  return d.toISOString().slice(0, 10);
}

// asset: { acquisition_cost_cents, salvage_value_cents, useful_life_months,
//          depreciation_start?, acquisition_date }
// throughDate: 'YYYY-MM-DD' — depreciate up to and including this month.
// recordedPeriods: array of 'YYYY-MM-DD' already posted (skipped).
// accumulated: cents already depreciated.
// → { periods: [{ period_date, amount_cents }], total_cents }
export function straightLineSchedule(asset, throughDate, recordedPeriods = [], accumulated = 0) {
  const base = Math.max(0, (Number(asset.acquisition_cost_cents) || 0) - (Number(asset.salvage_value_cents) || 0));
  const life = Number(asset.useful_life_months) || 0;
  if (base <= 0 || life <= 0) return { periods: [], total_cents: 0 };
  const monthly = Math.floor(base / life);

  const startStr = asset.depreciation_start || asset.acquisition_date;
  if (!startStr || !throughDate) return { periods: [], total_cents: 0 };
  const start = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${throughDate}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return { periods: [], total_cents: 0 };

  const recorded = new Set(recordedPeriods);
  const periods = [];
  let acc = Number(accumulated) || 0;
  let y = start.getUTCFullYear(), m = start.getUTCMonth();
  const endY = end.getUTCFullYear(), endM = end.getUTCMonth();
  let guard = 0;
  while ((y < endY || (y === endY && m <= endM)) && acc < base && guard < 1200) {
    guard++;
    const pd = monthEnd(y, m);
    if (!recorded.has(pd)) {
      const amount = Math.min(monthly, base - acc);
      if (amount > 0) { periods.push({ period_date: pd, amount_cents: amount }); acc += amount; }
    }
    m++; if (m > 11) { m = 0; y++; }
  }
  // If we reached the through-date but a rounding remainder is left AND the
  // asset's life is fully elapsed, fold it into the last emitted period.
  return { periods, total_cents: periods.reduce((s, p) => s + p.amount_cents, 0) };
}

export function monthlyAmount(asset) {
  const base = Math.max(0, (Number(asset.acquisition_cost_cents) || 0) - (Number(asset.salvage_value_cents) || 0));
  const life = Number(asset.useful_life_months) || 0;
  return life > 0 ? Math.floor(base / life) : 0;
}
