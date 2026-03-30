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

  return data.skus.map(s => {
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

    const filteredOnOrder = Object.values(poDates).reduce((a, b) => a + b, 0);
    const filteredOnCommitted = Object.values(soDates).reduce((a, b) => a + b, 0);
    return { sku: s.sku, description: s.description, category: s.category, store: s.store, onHand: s.onHand, onOrder: filteredOnOrder, onCommitted: filteredOnCommitted, dates: dateMap, avgCost: s.avgCost, lastReceiptDate: s.lastReceiptDate, totalAmount: s.totalAmount };
  });
}
