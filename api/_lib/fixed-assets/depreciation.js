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

// ────────────────────────────────────────────────────────────────────────────
// Multi-method engine — server mirror of src/lib/depreciation.ts. Kept in sync
// by hand (js/ts split, like the menuKeys dual registry). Conventions:
//   • MID-MONTH (half-month) convention for time-based methods — first & last
//     calendar month earn a half period; schedule spans life+1 months; weights
//     sum to life so total depreciation == depreciable base to the cent.
//   • DECLINING BALANCE applies factor/life monthly to opening book value with
//     automatic straight-line switch-over; book never below salvage.
//   • UNITS OF PRODUCTION distributes base by per-period usage / units_total.
//   • DISPOSAL truncates the schedule to the disposal month.
// No GL posting anywhere.
// ────────────────────────────────────────────────────────────────────────────
const DB_FACTOR = { declining_balance_200: 2.0, declining_balance_150: 1.5 };
const rnd = (n) => Math.round(n);

function parseYearMonth(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})/.exec(String(s));
  if (!m) return null;
  const y = Number(m[1]), m0 = Number(m[2]) - 1;
  if (!Number.isFinite(y) || m0 < 0 || m0 > 11) return null;
  return { y, m0 };
}

export function midMonthWeights(life) {
  if (life <= 0) return [];
  const w = [0.5];
  for (let i = 1; i < life; i++) w.push(1);
  w.push(0.5);
  return w;
}

function truncateAtDisposal(rows, disposal, cost) {
  if (!disposal) return rows;
  const cutoff = monthEnd(disposal.y, disposal.m0);
  const kept = rows.filter((row) => row.period_date <= cutoff);
  let acc = 0;
  for (const row of kept) { acc += row.depreciation_cents; row.accumulated_cents = acc; row.book_value_cents = cost - acc; }
  return kept;
}

// asset: { acquisition_cost_cents, salvage_value_cents, useful_life_months,
//   method, in_service_date|depreciation_start|acquisition_date, units_total, disposed_date }
// unitsByPeriod: array (units_of_production only).
// → [{ period_date, depreciation_cents, accumulated_cents, book_value_cents }]
export function buildSchedule(asset, unitsByPeriod) {
  const cost = Math.max(0, Math.round(Number(asset.acquisition_cost_cents) || 0));
  const salvage = Math.max(0, Math.round(Number(asset.salvage_value_cents) || 0));
  const life = Math.round(Number(asset.useful_life_months) || 0);
  const base = Math.max(0, cost - salvage);
  const method = String(asset.method || "straight_line");
  const start = parseYearMonth(asset.in_service_date || asset.depreciation_start || asset.acquisition_date);
  if (base <= 0 || life <= 0 || !start) return [];

  const disposal = parseYearMonth(asset.disposed_date);
  const rows = [];
  let accum = 0;

  if (method === "units_of_production") {
    const total = Math.round(Number(asset.units_total) || 0);
    const usage = unitsByPeriod || [];
    if (total <= 0 || usage.length === 0) return [];
    let cumUnits = 0;
    for (let i = 0; i < usage.length && accum < base; i++) {
      cumUnits += Math.max(0, Number(usage[i]) || 0);
      const target = Math.min(base, rnd((base * Math.min(cumUnits, total)) / total));
      const dep = target - accum;
      if (dep <= 0) continue;
      const y = start.y + Math.floor((start.m0 + i) / 12);
      const m0 = (start.m0 + i) % 12;
      accum = target;
      rows.push({ period_date: monthEnd(y, m0), depreciation_cents: dep, accumulated_cents: accum, book_value_cents: cost - accum });
    }
    return truncateAtDisposal(rows, disposal, cost);
  }

  const weights = midMonthWeights(life);
  const totalW = weights.reduce((s, x) => s + x, 0);
  const dbFactor = DB_FACTOR[method];
  const dbMonthlyRate = dbFactor ? dbFactor / life : 0;
  let cumW = 0;
  for (let i = 0; i < weights.length && accum < base; i++) {
    const w = weights[i];
    const remainingW = totalW - cumW;
    cumW += w;
    let dep;
    if (!dbFactor) {
      const target = Math.min(base, rnd((base * cumW) / totalW));
      dep = target - accum;
    } else {
      const book = cost - accum;
      const rem = book - salvage;
      if (rem <= 0) break;
      const dbDep = book * dbMonthlyRate * w;
      const slDep = remainingW > 0 ? (rem * w) / remainingW : rem;
      dep = rnd(Math.min(rem, Math.max(dbDep, slDep)));
      if (dep > rem) dep = rem;
    }
    if (dep <= 0) continue;
    const y = start.y + Math.floor((start.m0 + i) / 12);
    const m0 = (start.m0 + i) % 12;
    accum += dep;
    if (accum > base) { dep -= accum - base; accum = base; }
    rows.push({ period_date: monthEnd(y, m0), depreciation_cents: dep, accumulated_cents: accum, book_value_cents: cost - accum });
  }
  return truncateAtDisposal(rows, disposal, cost);
}
