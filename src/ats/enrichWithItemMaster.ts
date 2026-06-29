import type { ATSRow } from "./types";
import { resolveStyle, isItemMasterLoaded } from "./itemMasterLookup";
import { brandNameById, brandNameForStyle, brandIdForStyle } from "./brandLookup";

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
      master_description: resolved.description,
      // Brand comes from the Tangerine style_master (matched by style code)
      // — the authoritative per-style brand. ip_item_master.brand_id is
      // backfilled to the ROF default on every row, so it's only a
      // last-resort fallback for styles absent from style_master.
      master_brand_id: brandIdForStyle(resolved.style) ?? resolved.brand_id,
      master_brand: brandNameForStyle(resolved.style) ?? brandNameById(resolved.brand_id),
      // Gender from the master (Xoro GenderCode). The ATS feed's per-row
      // Gender column is frequently blank, so this is the authoritative
      // value the filter/reports prefer over r.gender.
      master_gender: resolved.gender,
      master_match_source: resolved.match_source,
    };
  });

  const matched = bySku + byStyle;
  const unmatched = total - matched;
  const summary: EnrichmentSummary = { total, matched, bySku, byStyle, unmatched };

  // Suppress the warn/unmatched dump when the master cache hasn't
  // loaded yet — first render computes rows before loadItemMasterCache()
  // resolves, so every row comes back unmatched and the log was a
  // misleading false positive. Once the master arrives, ATS recomputes
  // and this same function runs again with a populated cache, producing
  // the real coverage line.
  if (!isItemMasterLoaded()) {
    console.info(`[ats master] item master not loaded yet — coverage check deferred (${total} rows)`);
  } else if (unmatched === 0) {
    console.info(`[ats master] coverage 100% (${matched}/${total} matched: ${bySku} by sku, ${byStyle} by style)`);
  } else {
    const pct = ((matched / total) * 100).toFixed(1);
    console.warn(`[ats master] coverage ${pct}% (${matched}/${total} matched: ${bySku} by sku, ${byStyle} by style — ${unmatched} UNMATCHED)`);
    // Phase 1 diagnostic: always log the full unmatched list inline as a
    // newline-separated string so it's directly copyable from the console
    // without needing to expand an Array.
    console.warn(`[ats master] unmatched skus (${unmatched}):\n${unmatchedSkus.join("\n")}`);
  }

  return { rows: enriched, summary };
}
