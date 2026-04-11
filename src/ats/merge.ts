import type { ATSRow, ATSSkuData, ExcelData } from "./types";

// Collapses duplicate sku entries (same sku + same store) into a single row
// by summing numeric fields and computing a weighted avg cost. Pure; safe to
// run on already-clean data. Used both at upload time (persisted) and as a
// belt-and-suspenders guard inside computeRowsFromExcelData.
export function dedupeSkuEntries(skus: ATSSkuData[]): ATSSkuData[] {
  const out: ATSSkuData[] = [];
  const seen = new Map<string, number>();
  for (const s of skus) {
    const key = `${s.sku}::${s.store ?? "ROF"}`;
    const idx = seen.get(key);
    if (idx === undefined) {
      seen.set(key, out.length);
      out.push({ ...s });
      continue;
    }
    const prev = out[idx];
    const totalOnHand = (prev.onHand || 0) + (s.onHand || 0);
    const anyCost = prev.avgCost != null || s.avgCost != null;
    const costSum =
      (prev.avgCost ?? 0) * (prev.onHand || 0) +
      (s.avgCost   ?? 0) * (s.onHand   || 0);
    out[idx] = {
      ...prev,
      onHand:      totalOnHand,
      onOrder:     (prev.onOrder     || 0) + (s.onOrder     || 0),
      onCommitted: (prev.onCommitted || 0) + (s.onCommitted || 0),
      totalAmount: (prev.totalAmount || 0) + (s.totalAmount || 0),
      avgCost: anyCost && totalOnHand > 0 ? costSum / totalOnHand : (prev.avgCost ?? s.avgCost ?? undefined),
    };
  }
  return out;
}

// Wraps dedupeSkuEntries for whole ExcelData blobs — call this in the upload
// and load pipelines before persistence.
export function dedupeExcelData(data: ExcelData): ExcelData {
  const skus = dedupeSkuEntries(data.skus);
  if (skus.length === data.skus.length) return data; // no change
  return { ...data, skus };
}

// Bakes a `fromSku → toSku` merge into an ExcelData blob: renames events,
// folds all matching sku entries (including duplicates across stores or
// stale rows) into one merged entry, and leaves the rest untouched.
//
// This is the canonical merge — `commitMerge` and `loadFromSupabase` both
// apply it. Tested in __tests__/merge.test.ts.
export function mergeExcelDataSkus(data: ExcelData, fromSku: string, toSku: string): ExcelData {
  if (fromSku === toSku) return data;
  const pos = (data.pos || []).map(p => p.sku === fromSku ? { ...p, sku: toSku } : p);
  const sos = (data.sos || []).map(s => s.sku === fromSku ? { ...s, sku: toSku } : s);

  const fromEntries = data.skus.filter(s => s.sku === fromSku);
  const toEntries   = data.skus.filter(s => s.sku === toSku);
  const others      = data.skus.filter(s => s.sku !== fromSku && s.sku !== toSku);

  if (fromEntries.length === 0 && toEntries.length === 0) {
    return { ...data, skus: others, pos, sos };
  }

  const all = [...toEntries, ...fromEntries];
  const base = toEntries[0] ?? fromEntries[0];
  const totalOnHand = all.reduce((a, s) => a + (s.onHand || 0), 0);
  const costSum = all.reduce((a, s) => a + ((s.avgCost ?? 0) * (s.onHand || 0)), 0);
  const anyCost = all.some(s => s.avgCost != null);
  const merged = {
    ...base,
    sku:         toSku,
    onHand:      totalOnHand,
    onOrder:     all.reduce((a, s) => a + (s.onOrder     || 0), 0),
    onCommitted: all.reduce((a, s) => a + (s.onCommitted || 0), 0),
    totalAmount: all.reduce((a, s) => a + (s.totalAmount || 0), 0),
    avgCost: anyCost && totalOnHand > 0 ? costSum / totalOnHand : (base.avgCost ?? undefined),
  };

  return { ...data, skus: [...others, merged], pos, sos };
}

// Row-level merge for the legacy non-excelData code path. Used when a user
// merges while rows come from ats_snapshots instead of an uploaded workbook.
export function mergeRows(currentRows: ATSRow[], fromSku: string, toSku: string): ATSRow[] {
  const source = currentRows.find(r => r.sku === fromSku);
  const target = currentRows.find(r => r.sku === toSku);
  if (!source || !target) return currentRows;
  const mergedDates: Record<string, number> = { ...target.dates };
  for (const [d, q] of Object.entries(source.dates)) {
    mergedDates[d] = (mergedDates[d] ?? 0) + q;
  }
  const totalOnHand = target.onHand + source.onHand;
  const avgCost = totalOnHand > 0 && target.avgCost != null && source.avgCost != null
    ? (target.avgCost * target.onHand + source.avgCost * source.onHand) / totalOnHand
    : (target.avgCost ?? source.avgCost);
  const lastReceiptDate = [target.lastReceiptDate, source.lastReceiptDate].filter(Boolean).sort().pop();
  const merged: ATSRow = {
    ...target,
    onHand:      totalOnHand,
    onOrder:     target.onOrder     + source.onOrder,
    onCommitted: (target.onCommitted ?? 0) + (source.onCommitted ?? 0),
    totalAmount: (target.totalAmount ?? 0) + (source.totalAmount ?? 0),
    avgCost,
    lastReceiptDate,
    dates: mergedDates,
  };
  return currentRows.filter(r => r.sku !== fromSku && r.sku !== toSku).concat(merged);
}
