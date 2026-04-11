import type { ATSRow, ExcelData } from "./types";

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

  // Dedupe skus by sku+store — defensive guard against duplicate source rows
  // (upload artifacts, legacy merges) that would otherwise render twice.
  const dedupedSkus: typeof data.skus = [];
  const seen = new Map<string, number>();
  for (const s of data.skus) {
    const key = `${s.sku}::${s.store ?? "ROF"}`;
    const idx = seen.get(key);
    if (idx === undefined) {
      seen.set(key, dedupedSkus.length);
      dedupedSkus.push({ ...s });
    } else {
      const prev = dedupedSkus[idx];
      const totalOnHand = (prev.onHand || 0) + (s.onHand || 0);
      const anyCost = prev.avgCost != null || s.avgCost != null;
      const costSum = (prev.avgCost ?? 0) * (prev.onHand || 0) + (s.avgCost ?? 0) * (s.onHand || 0);
      dedupedSkus[idx] = {
        ...prev,
        onHand:      totalOnHand,
        onOrder:     (prev.onOrder     || 0) + (s.onOrder     || 0),
        onCommitted: (prev.onCommitted || 0) + (s.onCommitted || 0),
        totalAmount: (prev.totalAmount || 0) + (s.totalAmount || 0),
        avgCost: anyCost && totalOnHand > 0 ? costSum / totalOnHand : (prev.avgCost ?? s.avgCost ?? null),
      };
    }
  }

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
      if (atsAtDate == null || atsAtDate <= 0) { freeMap[date] = 0; continue; }
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
    return { sku: s.sku, description: s.description, category: s.category, store: s.store, onHand: s.onHand, onOrder: filteredOnOrder, onCommitted: filteredOnCommitted, dates: dateMap, freeMap, avgCost: s.avgCost, lastReceiptDate: s.lastReceiptDate, totalAmount: s.totalAmount };
  });
}
