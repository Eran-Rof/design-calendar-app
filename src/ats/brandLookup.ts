// Brand cache for the ATS Brand filter.
//
// Loads the full brand_master list (P15 Brand Master — the same brands the
// Tangerine app shows in its global brand picker) once per session and
// answers id → name lookups synchronously. ATS rows carry a brand_id
// resolved from ip_item_master (see itemMasterLookup); this module turns
// that id into the human brand NAME the filter dropdown lists.
//
// Read straight from PostgREST (brand_master has anon read RLS) instead of
// the /api/internal/brands handler so it works on any host the ATS bundle is
// served from, mirroring how itemMasterLookup reads ip_item_master directly.

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

async function fetchAllBrands(): Promise<BrandRecord[]> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const url = `${SB_URL}/rest/v1/brand_master?select=id,code,name,sort_order&order=sort_order.asc,name.asc`;
  const r = await fetch(url, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`Supabase GET brand_master failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as BrandRecord[];
}

/** Loads + indexes brand_master. Idempotent — concurrent callers share the
 *  in-flight Promise. On failure clears the cached Promise so the next call
 *  retries. Safe to call alongside loadItemMasterCache(). */
export async function loadBrandCache(): Promise<void> {
  if (cachePromise) return cachePromise;
  cachePromise = (async () => {
    try {
      const rows = await fetchAllBrands();
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
      console.info(`[ats brand] loaded ${rows.length} brands: ${names.join(", ")}`);
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

/** Ordered list of every brand name (the dropdown option set). Empty until
 *  the cache loads. */
export function getAllBrandNames(): string[] {
  return orderedNames;
}

/** True once the cache has been built (regardless of row count). */
export function isBrandsLoaded(): boolean {
  return byId !== null;
}

/** Visible for tests — inject a pre-built brand set without hitting the API. */
export function __setBrandCacheForTest(records: BrandRecord[]): void {
  const m = new Map<string, BrandRecord>();
  const names: string[] = [];
  for (const b of records) {
    if (b.id) m.set(b.id, b);
    if (b.name && !names.includes(b.name)) names.push(b.name);
  }
  byId = m;
  orderedNames = names;
  cachePromise = Promise.resolve();
}
