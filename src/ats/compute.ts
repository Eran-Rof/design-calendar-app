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
  // 2026-05-21: Xoro now reports PPK SKUs in eaches (not packs). The
  // historical pack→unit multiplication is no longer needed — the
  // source value IS the eaches count. Function kept for snapshot/
  // recovery-path callers but is now a no-op other than pinning
  // ppkMult=1 so downstream display logic treats the row as plain.
  return { ...row, ppkMult: 1 };
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

    // 2026-05-21: Xoro now reports inventory + PO/SO qtys in EACHES
    // for prepack SKUs (previously packs). No multiplication needed —
    // the source value IS the eaches count. masterHit is still used
    // downstream for description/category resolution; ppkMult is
    // pinned to 1 so the grid renders the number plainly without the
    // (now misleading) "PPK24 × N" hint.
    const masterHit = resolveStyle(s.sku, null);

    let ats = s.onHand;
    for (const [date, qty] of Object.entries(poDates)) {
      if (date < rangeStart) ats += qty;
    }
    for (const [date, qty] of Object.entries(soDates)) {
      if (date < rangeStart) ats -= qty;
    }
    if (ats < 0) ats = 0;

    const dateMap: Record<string, number> = {};
    for (const date of dates) {
      ats += (poDates[date] ?? 0) - (soDates[date] ?? 0);
      dateMap[date] = ats;
    }

    // Free-to-sell (AT SHIP): qty that can be committed now without leaving any
    // future SO uncovered. We walk future events in chronological order and track
    // the minimum running balance — that tells us the peak reserve needed.
    //
    // Example: PO in July, SO in June → July PO cannot cover the June SO,
    // so current stock must be reserved. Simple "totalPO - totalSO" would miss this.
    // Source data is in eaches grain (2026-05-21 change); no multiplier needed.
    const allFutureEvents: [string, number][] = [
      ...Object.entries(poDates).map(([d, q]): [string, number] => [d, q]),
      ...Object.entries(soDates).map(([d, q]): [string, number] => [d, -q]),
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

    // Aggregates already in eaches grain (2026-05-21 — Xoro report
    // change). s.onPO / s.onOrder fallback paths come from the same
    // inventory snapshot, also eaches now, so no multiplication.
    const filteredOnOrder = Object.values(poDates).reduce((a, b) => a + b, 0);
    const filteredOnCommitted = Object.values(soDates).reduce((a, b) => a + b, 0);
    const onPO = filteredOnOrder > 0 ? filteredOnOrder : (s.onPO || 0);
    const onOrder = filteredOnCommitted > 0 ? filteredOnCommitted : (s.onOrder || 0);
    // Cost: Item Costing Report may still report at pack grain even
    // after the 2026-05-21 inventory-grain switch. Divide by master
    // pack_size to land at per-unit, matching the row contract. Safe
    // to revisit (and remove this division) if cost grain is also
    // confirmed eaches.
    const mult = masterHit.pack_size;
    const avgCost = s.avgCost != null && mult > 1 ? s.avgCost / mult : s.avgCost;
    return { sku: s.sku, description: s.description, category: s.category, gender: s.gender, store: s.store, onHand: s.onHand, onPO, onOrder, dates: dateMap, freeMap, avgCost, lastReceiptDate: s.lastReceiptDate, totalAmount: s.totalAmount, ppkMult: 1 };
  });
}
