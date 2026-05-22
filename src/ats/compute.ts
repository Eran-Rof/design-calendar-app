import type { ATSRow, ExcelData } from "./types";
import { dedupeSkuEntries } from "./merge";
import { resolveStyle } from "./itemMasterLookup";

// Per-period qty resolver shared by the grid, the export, and totals.
// In Avail-to-Ship mode the FIRST period shows the cumulative
// free-to-sell as-is; each SUBSEQUENT period shows only the
// additional qty that became available since the prior period
// (typically new PO receipts). Negative deltas (more reservations
// stealing earlier free stock) clamp to 0 — those aren't "new
// availability". When atShip is off, every period shows the running
// ATS balance straight from row.dates (existing behavior).
export function periodAvail(
  row: ATSRow,
  periods: Array<{ endDate: string }>,
  i: number,
  atShip: boolean,
): number {
  if (!atShip) {
    const v = row.dates[periods[i].endDate];
    return typeof v === "number" ? v : 0;
  }
  const free = (date: string): number => {
    const v = row.freeMap?.[date] ?? row.dates[date];
    return typeof v === "number" ? v : 0;
  };
  const cur = free(periods[i].endDate);
  if (i === 0) return cur;
  const prev = free(periods[i - 1].endDate);
  return Math.max(0, cur - prev);
}

/** Apply the PPK pack→unit multiplier to a single ATSRow. Used by the
 *  snapshot-path loader (loadFromSupabase fallback to ats_snapshots)
 *  and by the master-ready recovery effect — both build rows without
 *  going through computeRowsFromExcelData and so skip the multiplier
 *  step normally embedded in compute. Idempotency note: this function
 *  is NOT idempotent. Call exactly once on a row, only on rows that
 *  have not already been multiplied. The Excel-upload path runs the
 *  multiplier inside compute itself; never call this on rows from
 *  that path. */
export function applyPpkMultiplierToRow(row: ATSRow): ATSRow {
  // Snapshot/recovery-path multiplier. Mirrors the conditional rule in
  // computeRowsFromExcelData: pack grain is signaled by the SIZE field
  // (e.g. size=PPK24). The size column is authoritative because a
  // single style+color can have a mix of sized variants in eaches grain
  // and a PPK row in pack grain.
  const masterHit = resolveStyle(row.sku, null);
  const isPackGrain = /PPK/i.test(masterHit.size ?? "");
  const mult = isPackGrain ? masterHit.pack_size : 1;
  if (mult === 1) return { ...row, ppkMult: 1 };
  const newDates: Record<string, number> = {};
  for (const [date, qty] of Object.entries(row.dates)) newDates[date] = qty * mult;
  let newFreeMap: Record<string, number> | undefined;
  if (row.freeMap) {
    newFreeMap = {};
    for (const [date, qty] of Object.entries(row.freeMap)) newFreeMap[date] = qty * mult;
  }
  return {
    ...row,
    onHand: row.onHand * mult,
    onPO: row.onPO * mult,
    onOrder: row.onOrder * mult,
    dates: newDates,
    freeMap: newFreeMap,
    avgCost: row.avgCost != null ? row.avgCost / mult : row.avgCost,
    ppkMult: mult,
  };
}

export function computeRowsFromExcelData(data: ExcelData, dates: string[], poStores: string[] = ["All"], soStores: string[] = ["All"]): ATSRow[] {
  const allPo = poStores.includes("All");
  const allSo = soStores.includes("All");

  // Pre-index events by SKU::STORE → date → qty so each store row only gets its own events
  const poIdx: Record<string, Record<string, number>> = {};
  const soIdx: Record<string, Record<string, number>> = {};
  for (const p of data.pos) {
    if (!allPo && !poStores.includes(p.store ?? "ROF")) continue;
    const key = `${p.sku}::${p.store ?? "ROF"}`;
    if (!poIdx[key]) poIdx[key] = {};
    poIdx[key][p.date] = (poIdx[key][p.date] ?? 0) + p.qty;
  }
  for (const o of data.sos) {
    if (!allSo && !soStores.includes(o.store ?? "ROF")) continue;
    const key = `${o.sku}::${o.store ?? "ROF"}`;
    if (!soIdx[key]) soIdx[key] = {};
    soIdx[key][o.date] = (soIdx[key][o.date] ?? 0) + o.qty;
  }

  const rangeStart = dates[0];

  // Belt-and-suspenders dedupe — upload/load paths already clean the data,
  // but a second pass here is cheap and catches legacy snapshots.
  const dedupedSkus = dedupeSkuEntries(data.skus);

  return dedupedSkus.map(s => {
    const rowKey = `${s.sku}::${s.store ?? "ROF"}`;
    const poDates = poIdx[rowKey] ?? {};
    const soDates = soIdx[rowKey] ?? {};

    // 2026-05-21 (rev 2): Pack grain is per-row, signaled by the SIZE
    // column. Operator clarified: "if PPK in size, it's a PPK for that
    // item-size qty only" — meaning a single style+color can have a
    // mix of sized variants (size=31/32/33/... in eaches grain) AND a
    // PPK row (size=PPK24, pack grain). The size field is authoritative
    // regardless of whether style_code itself ends in "PPK".
    //
    // Examples:
    //   - RYB059430-SALTLAKE-MEDWASH    size=PPK24, pack_size=24 → multiply
    //   - RYB059430PPK-BARK-GREYWTINT   size=PPK24, pack_size=24 → multiply
    //   - RYB059430-SALTLAKE-MEDWASH-32 size=32,    pack_size=1  → no-op
    //   - RYB059430-BARK-GREYWTINT      size=null,  pack_size=1  → no-op
    const masterHit = resolveStyle(s.sku, null);
    const isPackGrain = /PPK/i.test(masterHit.size ?? "");
    const mult = isPackGrain ? masterHit.pack_size : 1;

    let ats = s.onHand * mult;
    for (const [date, qty] of Object.entries(poDates)) {
      if (date < rangeStart) ats += qty * mult;
    }
    for (const [date, qty] of Object.entries(soDates)) {
      if (date < rangeStart) ats -= qty * mult;
    }
    if (ats < 0) ats = 0;

    const dateMap: Record<string, number> = {};
    for (const date of dates) {
      ats += ((poDates[date] ?? 0) - (soDates[date] ?? 0)) * mult;
      dateMap[date] = ats;
    }

    // Free-to-sell (AT SHIP): qty that can be committed now without leaving any
    // future SO uncovered. We walk future events in chronological order and track
    // the minimum running balance — that tells us the peak reserve needed.
    //
    // Example: PO in July, SO in June → July PO cannot cover the June SO,
    // so current stock must be reserved. Simple "totalPO - totalSO" would miss this.
    // Event deltas multiplied by `mult` so the math runs in eaches grain
    // (matches ats / dateMap above). mult=1 for bare-style rows.
    const allFutureEvents: [string, number][] = [
      ...Object.entries(poDates).map(([d, q]): [string, number] => [d, q * mult]),
      ...Object.entries(soDates).map(([d, q]): [string, number] => [d, -q * mult]),
    ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const freeMap: Record<string, number> = {};
    for (const date of dates) {
      const atsAtDate = dateMap[date];
      if (atsAtDate == null) { freeMap[date] = 0; continue; }
      if (atsAtDate <= 0) { freeMap[date] = atsAtDate; continue; } // preserve 0 or negative as-is
      // Walk future events in order, find maximum reserve needed
      let running = 0;
      let minRunning = 0;
      for (const [d, delta] of allFutureEvents) {
        if (d <= date) continue;
        running += delta;
        if (running < minRunning) minRunning = running;
      }
      // minRunning is 0 or negative; reserve = how much current stock is needed
      const reserveNeeded = Math.max(0, -minRunning);
      freeMap[date] = Math.max(0, atsAtDate - reserveNeeded);
    }

    // Multiplied aggregates so onPO/onOrder land in eaches grain
    // alongside the per-date deltas. For bare-style rows mult=1 (no-op).
    const filteredOnOrder = Object.values(poDates).reduce((a, b) => a + b, 0) * mult;
    const filteredOnCommitted = Object.values(soDates).reduce((a, b) => a + b, 0) * mult;
    const onPO = filteredOnOrder > 0 ? filteredOnOrder : (s.onPO || 0) * mult;
    const onOrder = filteredOnCommitted > 0 ? filteredOnCommitted : (s.onOrder || 0) * mult;
    // Cost grain matches qty grain: pack-grain rows have pack-priced
    // avgCost (divide by pack_size); bare-style rows are per-unit
    // already (mult=1, no division).
    const avgCost = s.avgCost != null && mult > 1 ? s.avgCost / mult : s.avgCost;
    // ppkMult is the *applied* multiplier — pack_size for PPK-suffixed
    // style rows (so the grid renders the chip + EXPLODE toggle works),
    // 1 for bare-style rows (so they render plain, even though their
    // master pack_size may be >1 from the size column).
    return { sku: s.sku, description: s.description, category: s.category, gender: s.gender, store: s.store, onHand: s.onHand * mult, onPO, onOrder, dates: dateMap, freeMap, avgCost, lastReceiptDate: s.lastReceiptDate, totalAmount: s.totalAmount, ppkMult: mult };
  });
}
