import type { ATSRow, ExcelData } from "./types";
import { dedupeSkuEntries } from "./merge";
import { ppkMultiplier } from "../shared/prepack";
import { resolveStyle } from "./itemMasterLookup";

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
  const masterHit = resolveStyle(row.sku, null);
  const mult = ppkMultiplier(
    null,
    masterHit.size,
    row.description,
    masterHit.style ?? row.sku,
    row.sku,
  );
  if (mult === 1) return row;
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

    // PPK explosion. Xoro reports qtys in PACKS for prepack SKUs.
    // The pack-size token (e.g. "PPK24" = 24 units per pack) lives in
    // the size field 90% of the time, occasionally in the style code
    // (e.g. "...PPK48") or description. Source the size from the item
    // master cache when available since the SKU + description we get
    // from Xoro often don't carry it. Falls back to scanning the
    // description / SKU when the master hasn't loaded yet or the row
    // is unmatched. resolveStyle is sync once the cache is loaded.
    const masterHit = resolveStyle(s.sku, null);
    const mult = ppkMultiplier(
      null,                       // ATS doesn't carry a separate color field
      masterHit.size,             // primary: master's size column
      s.description,              // fallback: description text
      masterHit.style ?? s.sku,   // fallback: style code (PPK48 in style)
      s.sku,                      // last-resort fallback: full SKU
    );

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
    // PPK-applied event deltas so the AT SHIP free-to-sell math runs in
    // the same selling-unit space as dateMap above.
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

    // Aggregates are reported in selling units. The s.onPO / s.onOrder
    // fallback paths come from the inventory snapshot which is also
    // pack-grain for prepacks, so multiply both sides.
    const filteredOnOrder = Object.values(poDates).reduce((a, b) => a + b, 0) * mult;
    const filteredOnCommitted = Object.values(soDates).reduce((a, b) => a + b, 0) * mult;
    const onPO = filteredOnOrder > 0 ? filteredOnOrder : (s.onPO || 0) * mult;
    const onOrder = filteredOnCommitted > 0 ? filteredOnCommitted : (s.onOrder || 0) * mult;
    // Cost fields divide by mult so per-unit cost = pack cost / units-
    // per-pack. totalAmount is qty × unitCost in pack space; after the
    // qty multiplies and the cost divides, it stays the same number,
    // so we leave it as-is.
    const avgCost = s.avgCost != null ? s.avgCost / mult : s.avgCost;
    return { sku: s.sku, description: s.description, category: s.category, gender: s.gender, store: s.store, onHand: s.onHand * mult, onPO, onOrder, dates: dateMap, freeMap, avgCost, lastReceiptDate: s.lastReceiptDate, totalAmount: s.totalAmount };
  });
}
