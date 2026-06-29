// Brand cache for the ATS Brand filter + per-style brand resolution.
//
// Loads two things once per session (both straight from PostgREST — anon read
// RLS, so it works on any host the ATS bundle is served from, mirroring how
// itemMasterLookup reads ip_item_master directly):
//
//   1. brand_master — the full brand list (the same brands the Tangerine app
//      shows in its global brand picker). Powers the filter dropdown and
//      id → name resolution.
//   2. style_master — the Tangerine PLM style table, read as a
//      style_code → brand_id map. This is the AUTHORITATIVE per-style brand.
//
// WHY style_master and not ip_item_master.brand_id: the Xoro-fed
// ip_item_master.brand_id is backfilled to the ROF default on every row
// (verified in prod — 100% "Ring of Fire"), so it can't distinguish brands.
// The real brand assignment lives in Tangerine's style_master.brand_id
// (Ring of Fire / Psycho Tuna / Axe Crown / …). So ATS resolves a row's brand
// by MATCHING its style code to the Tangerine style and reading the brand
// there — the same style-code match the image thumbnails use.

import { SB_HEADERS, SB_URL } from "../utils/supabase";

export interface BrandRecord {
  id: string;
  code: string;
  name: string;
  sort_order: number | null;
}

let cachePromise: Promise<void> | null = null;
let byId: Map<string, BrandRecord> | null = null;
// Ordered (by sort_order) list of brand names — the canonical dropdown
// option set. "All brands from the Tangerine app", regardless of whether a
// given brand currently has any inventory rows in the grid.
let orderedNames: string[] = [];
// UPPER(style_code) → brand_master.id, from Tangerine's style_master.
let styleBrandId: Map<string, string> | null = null;

async function fetchAllBrands(): Promise<BrandRecord[]> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const url = `${SB_URL}/rest/v1/brand_master?select=id,code,name,sort_order&order=sort_order.asc,name.asc`;
  const r = await fetch(url, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`Supabase GET brand_master failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as BrandRecord[];
}

// Read the whole style_master (style_code, brand_id), paginated past the
// 1000-row PostgREST cap (the table is ~2k rows). Returns UPPER(style_code)
// → brand_id. First non-null brand per code wins.
async function fetchStyleBrandMap(): Promise<Map<string, string>> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const out = new Map<string, string>();
  const PAGE = 1000;
  for (let offset = 0; offset < 100000; offset += PAGE) {
    const url = `${SB_URL}/rest/v1/style_master?select=style_code,brand_id&order=style_code.asc&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) throw new Error(`Supabase GET style_master failed: ${r.status} ${await r.text()}`);
    const chunk = (await r.json()) as Array<{ style_code: string | null; brand_id: string | null }>;
    for (const row of chunk) {
      const codeUp = (row.style_code || "").trim().toUpperCase();
      if (codeUp && row.brand_id && !out.has(codeUp)) out.set(codeUp, row.brand_id);
    }
    if (chunk.length < PAGE) break;
  }
  return out;
}

/** Loads + indexes brand_master AND the style_master brand map. Idempotent —
 *  concurrent callers share the in-flight Promise. On failure clears the
 *  cached Promise so the next call retries. Safe to call alongside
 *  loadItemMasterCache(). */
export async function loadBrandCache(): Promise<void> {
  if (cachePromise) return cachePromise;
  cachePromise = (async () => {
    try {
      const [rows, styleMap] = await Promise.all([fetchAllBrands(), fetchStyleBrandMap()]);
      const m = new Map<string, BrandRecord>();
      const names: string[] = [];
      const seenName = new Set<string>();
      for (const b of rows) {
        if (b.id) m.set(b.id, b);
        // De-dupe by name (brands are unique per entity; a multi-entity
        // table could repeat a name — show it once).
        if (b.name && !seenName.has(b.name)) { seenName.add(b.name); names.push(b.name); }
      }
      byId = m;
      orderedNames = names;
      styleBrandId = styleMap;
      console.info(`[ats brand] loaded ${rows.length} brands + ${styleMap.size} style→brand mappings`);
    } catch (err) {
      console.error("[ats brand] load failed", err);
      cachePromise = null;
      throw err;
    }
  })();
  return cachePromise;
}

/** Brand NAME for a brand_master id, or null if unknown / cache not loaded. */
export function brandNameById(id: string | null | undefined): string | null {
  if (!id || !byId) return null;
  return byId.get(id)?.name ?? null;
}

/** brand_master id for a style code, resolved via Tangerine's style_master.
 *  Null when the style isn't in style_master or the cache isn't loaded. */
export function brandIdForStyle(styleCode: string | null | undefined): string | null {
  if (!styleCode || !styleBrandId) return null;
  return styleBrandId.get(styleCode.trim().toUpperCase()) ?? null;
}

/** Brand NAME for a style code (Tangerine style_master brand). Null when the
 *  style isn't matched or the cache isn't loaded. */
export function brandNameForStyle(styleCode: string | null | undefined): string | null {
  return brandNameById(brandIdForStyle(styleCode));
}

/** Ordered list of every brand name (the dropdown option set). Empty until
 *  the cache loads. */
export function getAllBrandNames(): string[] {
  return orderedNames;
}

/** True once the cache has been built (regardless of row count). */
export function isBrandsLoaded(): boolean {
  return byId !== null;
}

/** Visible for tests — inject a pre-built brand set (and optional
 *  style_code → brand_id map) without hitting the API. */
export function __setBrandCacheForTest(
  records: BrandRecord[],
  styleBrands: Record<string, string> = {},
): void {
  const m = new Map<string, BrandRecord>();
  const names: string[] = [];
  for (const b of records) {
    if (b.id) m.set(b.id, b);
    if (b.name && !names.includes(b.name)) names.push(b.name);
  }
  byId = m;
  orderedNames = names;
  styleBrandId = new Map(Object.entries(styleBrands).map(([k, v]) => [k.trim().toUpperCase(), v]));
  cachePromise = Promise.resolve();
}
