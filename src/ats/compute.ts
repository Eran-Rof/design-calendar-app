import type { ATSRow, ExcelData } from "./types";
import { dedupeSkuEntries } from "./merge";

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

    const filteredOnOrder = Object.values(poDates).reduce((a, b) => a + b, 0);
    const filteredOnCommitted = Object.values(soDates).reduce((a, b) => a + b, 0);
    // Use pos[] event total if available (has date-level detail for timeline),
    // otherwise fall back to the inventory API's QtyOnPO stored in s.onOrder.
    const onOrder = filteredOnOrder > 0 ? filteredOnOrder : (s.onOrder || 0);
    const onCommitted = filteredOnCommitted > 0 ? filteredOnCommitted : (s.onCommitted || 0);
    return { sku: s.sku, description: s.description, category: s.category, gender: s.gender, store: s.store, onHand: s.onHand, onOrder, onCommitted, dates: dateMap, freeMap, avgCost: s.avgCost, lastReceiptDate: s.lastReceiptDate, totalAmount: s.totalAmount };
  });
}
