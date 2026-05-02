import type { ATSRow } from "./types";
import { resolveStyle } from "./itemMasterLookup";

export interface EnrichmentSummary {
  total: number;
  matched: number;
  bySku: number;
  byStyle: number;
  unmatched: number;
}

// Phase 1 (dark ship): enrich ATS rows with item-master-resolved
// category / sub_category / style / color. Pure synchronous function — the
// item master cache is loaded out-of-band by `loadItemMasterCache()` in
// `itemMasterLookup`. If the cache is empty (e.g. not yet loaded) every row
// comes back unmatched and the coverage log says so. Acceptable for Phase 1.
export function enrichRowsWithItemMaster(rows: ATSRow[]): { rows: ATSRow[]; summary: EnrichmentSummary } {
  const total = rows.length;

  if (total === 0) {
    console.info("[ats master] no rows to enrich");
    return {
      rows: [],
      summary: { total: 0, matched: 0, bySku: 0, byStyle: 0, unmatched: 0 },
    };
  }

  let bySku = 0;
  let byStyle = 0;
  const unmatchedSkus: string[] = [];

  const enriched: ATSRow[] = rows.map(row => {
    // Mirror parseSku in agedInvenMath.ts: split on " - " (space-dash-space)
    // and take the first segment as the style fallback.
    const spaceDelim = row.sku.indexOf(" - ");
    const stylePartRaw = spaceDelim !== -1 ? row.sku.slice(0, spaceDelim) : row.sku;
    const stylePart = stylePartRaw.trim();
    const stylePartArg = stylePart.length > 0 ? stylePart : null;

    const resolved = resolveStyle(row.sku, stylePartArg);

    if (resolved.match_source === "sku") bySku++;
    else if (resolved.match_source === "style") byStyle++;
    else unmatchedSkus.push(row.sku);

    return {
      ...row,
      master_category: resolved.category,
      master_sub_category: resolved.sub_category,
      master_style: resolved.style,
      master_color: resolved.color,
      master_match_source: resolved.match_source,
    };
  });

  const matched = bySku + byStyle;
  const unmatched = total - matched;
  const summary: EnrichmentSummary = { total, matched, bySku, byStyle, unmatched };

  if (unmatched === 0) {
    console.info(`[ats master] coverage 100% (${matched}/${total} matched: ${bySku} by sku, ${byStyle} by style)`);
  } else {
    const pct = ((matched / total) * 100).toFixed(1);
    console.warn(`[ats master] coverage ${pct}% (${matched}/${total} matched: ${bySku} by sku, ${byStyle} by style — ${unmatched} UNMATCHED)`);
    if (unmatched <= 10) {
      console.warn("[ats master] unmatched skus:", unmatchedSkus);
    }
  }

  return { rows: enriched, summary };
}
