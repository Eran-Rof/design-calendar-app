import type { ExcelData } from "./types";
import { normalizeSku } from "./helpers";

export interface NormChange {
  original: string;
  normalized: string;
  sources: ("inventory" | "purchases" | "orders")[];
  accepted: boolean;
}

/** Detect all SKU normalization changes without applying them. */
export function detectNormChanges(data: ExcelData): NormChange[] {
  const map: Record<string, NormChange> = {};
  const add = (orig: string, source: NormChange["sources"][number]) => {
    const norm = normalizeSku(orig);
    if (norm === orig) return;
    if (!map[orig]) map[orig] = { original: orig, normalized: norm, sources: [], accepted: true };
    if (!map[orig].sources.includes(source)) map[orig].sources.push(source);
  };
  data.skus.forEach(s => add(s.sku, "inventory"));
  data.pos.forEach(p => add(p.sku, "purchases"));
  data.sos.forEach(s => add(s.sku, "orders"));
  return Object.values(map).sort((a, b) => a.original.localeCompare(b.original));
}

/** Apply only accepted normalization changes to ExcelData. */
export function applyNormChanges(data: ExcelData, changes: NormChange[]): ExcelData {
  const acceptedMap: Record<string, string> = {};
  for (const c of changes) {
    if (c.accepted) acceptedMap[c.original] = c.normalized;
  }
  const apply = (sku: string) => acceptedMap[sku] ?? sku;
  return {
    ...data,
    skus: data.skus.map(s => ({ ...s, sku: apply(s.sku) })),
    pos: data.pos.map(p => ({ ...p, sku: apply(p.sku) })),
    sos: data.sos.map(s => ({ ...s, sku: apply(s.sku) })),
  };
}

/** Normalize all SKU strings in ExcelData so inventory, POs, and SOs match.
 *  Fixes: double spaces, dash spacing, casing differences. */
export function normalizeExcelData(data: ExcelData): ExcelData {
  return {
    ...data,
    skus: data.skus.map(s => ({ ...s, sku: normalizeSku(s.sku) })),
    pos: data.pos.map(p => ({ ...p, sku: normalizeSku(p.sku) })),
    sos: data.sos.map(s => ({ ...s, sku: normalizeSku(s.sku) })),
  };
}
