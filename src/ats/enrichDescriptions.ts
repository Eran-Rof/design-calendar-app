import type { ExcelData } from "./types";
import { SB_URL, SB_KEY, SB_HEADERS } from "../utils/supabase";
import { xoroSkuToExcel, normalizeSku } from "./helpers";

/** Fill in blank descriptions from PO WIP data (tanda_pos).
 *  Tries exact match first, then normalized match. */
export async function enrichDescriptions(data: ExcelData): Promise<ExcelData> {
  // Find SKUs with blank descriptions
  const blankSkus = data.skus.filter(s => !s.description?.trim());
  if (blankSkus.length === 0) return data;

  const blankSet = new Set(blankSkus.map(s => s.sku));
  // Also build normalized lookup for fuzzy matching
  const blankNormMap: Record<string, string> = {};
  for (const s of blankSkus) {
    blankNormMap[normalizeSku(s.sku).toLowerCase()] = s.sku;
  }

  const descMap: Record<string, string> = {};

  // Try PO WIP data (tanda_pos has full Xoro item details with Description field)
  try {
    const res = await fetch(`${SB_URL}/rest/v1/tanda_pos?select=data`, { headers: SB_HEADERS });
    const rows = await res.json();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const items = row.data?.Items || row.data?.PoLineArr || [];
        for (const item of items) {
          if (!item.Description) continue;
          const rawSku = item.ItemNumber || "";
          // Try exact conversion match
          const excelSku = xoroSkuToExcel(rawSku);
          if (blankSet.has(excelSku) && !descMap[excelSku]) {
            descMap[excelSku] = item.Description;
            continue;
          }
          // Try normalized match (handles spacing/casing differences)
          const normExcel = normalizeSku(excelSku).toLowerCase();
          if (blankNormMap[normExcel] && !descMap[blankNormMap[normExcel]]) {
            descMap[blankNormMap[normExcel]] = item.Description;
            continue;
          }
          // Try base part match (e.g. "BRMB1516NTE" matches any color variant)
          const basePart = rawSku.split("-")[0];
          for (const blank of blankSkus) {
            if (!descMap[blank.sku] && blank.sku.startsWith(basePart + " - ")) {
              descMap[blank.sku] = item.Description;
            }
          }
        }
      }
    }
  } catch (e) { console.warn("Could not load PO descriptions:", e); }

  if (Object.keys(descMap).length === 0) return data;
  console.log(`[ATS] Enriched descriptions for ${Object.keys(descMap).length} SKUs from PO data`);

  // Apply enriched descriptions
  const enriched = {
    ...data,
    skus: data.skus.map(s => {
      if (!s.description?.trim() && descMap[s.sku]) {
        return { ...s, description: descMap[s.sku] };
      }
      return s;
    }),
  };

  return enriched;
}
