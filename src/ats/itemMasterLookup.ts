// Phase 1 (dark ship) — read-only lookup against the planning app's
// `ip_item_master` table. Used by ATS to resolve Category / Sub Cat /
// Style / Color from canonical master data instead of inferring from
// the freeform SKU + description combo.
//
// The cache is module-scoped: we load the full master once per session
// (small enough to fit comfortably in memory — ~20k rows max) and
// answer subsequent lookups synchronously. `loadItemMasterCache()` is
// idempotent and safe to call concurrently — repeat calls return the
// same in-flight Promise rather than re-fetching.
//
// Mirrors the paginated `sbGetAll` pattern in
// `src/inventory-planning/services/wholesalePlanningRepository.ts`.

import { SB_HEADERS, SB_URL } from "../utils/supabase";
import { normalizeSku } from "./helpers";

export interface ItemMasterRecord {
  id: string;
  sku_code: string;
  style_code: string | null;
  color: string | null;
  size: string | null;
  description: string | null;
  attributes: {
    group_name?: string | null;
    category_name?: string | null;
    sub_category_name?: string | null;
    gender?: string | null;
  } | null;
}

export interface ResolvedStyle {
  category: string | null;       // attributes.group_name
  sub_category: string | null;   // attributes.sub_category_name
  style: string | null;          // style_code
  color: string | null;          // color
  match_source: "sku" | "style" | null; // null = unmatched
}

// Module-level cache state.
let cachePromise: Promise<void> | null = null;
let bySkuCode: Map<string, ItemMasterRecord> | null = null;
let byStyleCode: Map<string, ItemMasterRecord> | null = null;

const NULL_RESULT: ResolvedStyle = {
  category: null,
  sub_category: null,
  style: null,
  color: null,
  match_source: null,
};

function buildIndexes(records: ItemMasterRecord[]): void {
  const sku = new Map<string, ItemMasterRecord>();
  const style = new Map<string, ItemMasterRecord>();
  for (const rec of records) {
    if (rec.sku_code) sku.set(rec.sku_code, rec);
    if (rec.style_code) {
      // Case-insensitive style lookup: ATS SKUs sometimes carry the style
      // code in lowercase or mixed case, while master is canonically
      // uppercase. Index by uppercase key so the resolver can match
      // regardless of casing.
      const styleKey = rec.style_code.toUpperCase();
      const existing = style.get(styleKey);
      if (!existing) {
        style.set(styleKey, rec);
      } else {
        // Deterministic tie-break: prefer the record with no color (the
        // "base" style row, if one exists), otherwise the lexicographically
        // smallest sku_code wins so injection order doesn't change results.
        const existingHasColor = !!existing.color;
        const recHasColor = !!rec.color;
        if (existingHasColor && !recHasColor) {
          style.set(styleKey, rec);
        } else if (existingHasColor === recHasColor && rec.sku_code < existing.sku_code) {
          style.set(styleKey, rec);
        }
      }
      // Whitespace alias: store under the space-stripped uppercase key too
      // so an ATS row with the opposite spacing still hits. Only insert if
      // the stripped key isn't already taken by a primary record (don't
      // shadow a real master row).
      const styleKeyNoSpace = styleKey.replace(/\s+/g, "");
      if (styleKeyNoSpace !== styleKey && !style.has(styleKeyNoSpace)) {
        style.set(styleKeyNoSpace, style.get(styleKey)!);
      }
    }
  }
  bySkuCode = sku;
  byStyleCode = style;
}

async function fetchAllItemMaster(): Promise<ItemMasterRecord[]> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const out: ItemMasterRecord[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SB_URL}/rest/v1/ip_item_master?select=*&order=sku_code.asc&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) {
      throw new Error(`Supabase GET ip_item_master failed: ${r.status} ${await r.text()}`);
    }
    const chunk = (await r.json()) as ItemMasterRecord[];
    out.push(...chunk);
    if (chunk.length < PAGE) break;
    if (offset > 1_000_000) break; // safety cap
  }
  return out;
}

/** Loads and indexes ip_item_master. Idempotent — concurrent callers
 *  share the same in-flight Promise. On failure, clears the cached
 *  Promise so the next call retries. */
export async function loadItemMasterCache(): Promise<void> {
  if (cachePromise) return cachePromise;
  cachePromise = (async () => {
    try {
      const rows = await fetchAllItemMaster();
      buildIndexes(rows);
      // Phase 1 diagnostic: log a small sample of master sku_codes inline as
      // text (not as a collapsed Array) so the format is visible without
      // needing to expand it in DevTools.
      if (rows.length > 0) {
        const sample = rows.slice(0, 8).map(r =>
          `sku_code="${r.sku_code}" style_code="${r.style_code ?? ""}" color="${r.color ?? ""}"`,
        ).join(" | ");
        console.info(`[item-master] loaded ${rows.length} rows. sample: ${sample}`);
      } else {
        console.warn("[item-master] loaded 0 rows — table empty?");
      }
    } catch (err) {
      console.error("[item-master] load failed", err);
      cachePromise = null;
      throw err;
    }
  })();
  return cachePromise;
}

/** Synchronous resolver. Returns an all-null result with
 *  `match_source: null` if the cache hasn't been loaded yet, or if
 *  neither sku_code nor style_code matched. Caller is responsible for
 *  logging unmatched lookups. */
export function resolveStyle(sku: string, stylePart?: string | null): ResolvedStyle {
  if (!bySkuCode || !byStyleCode) return { ...NULL_RESULT };

  const normalizedSku = normalizeSku(sku);
  const skuHit = bySkuCode.get(normalizedSku);
  if (skuHit) {
    return {
      category: skuHit.attributes?.group_name ?? null,
      sub_category: skuHit.attributes?.sub_category_name ?? null,
      style: skuHit.style_code ?? null,
      color: skuHit.color ?? null,
      match_source: "sku",
    };
  }

  if (stylePart) {
    const trimmed = stylePart.trim();
    if (trimmed) {
      // Case-insensitive: ATS rows occasionally carry lowercase or mixed-
      // case style codes (e.g. "ryb0335", "PTYG0003lstd") while master is
      // canonically uppercase. Match the index's uppercased key.
      const trimmedUpper = trimmed.toUpperCase();
      let styleHit = byStyleCode.get(trimmedUpper);
      // Whitespace fallback: ATS rows may have an internal space ("R7113 ED2")
      // where master has none ("R7113ED2") or vice versa. Try the stripped
      // form against the index's whitespace alias.
      if (!styleHit) {
        const noSpace = trimmedUpper.replace(/\s+/g, "");
        if (noSpace !== trimmedUpper) styleHit = byStyleCode.get(noSpace);
      }
      if (styleHit) {
        return {
          category: styleHit.attributes?.group_name ?? null,
          sub_category: styleHit.attributes?.sub_category_name ?? null,
          style: styleHit.style_code ?? null,
          color: styleHit.color ?? null,
          match_source: "style",
        };
      }
    }
  }

  return { ...NULL_RESULT };
}

/** Visible for tests + cache invalidation after the user adds new
 *  master rows in the planning app. Next `loadItemMasterCache()` call
 *  refetches. */
export function clearItemMasterCache(): void {
  cachePromise = null;
  bySkuCode = null;
  byStyleCode = null;
}

/** Visible for tests — inject a pre-built cache without hitting
 *  Supabase. Sets `cachePromise` to a resolved Promise so subsequent
 *  `loadItemMasterCache()` calls become no-ops. */
export function __setCacheForTest(records: ItemMasterRecord[]): void {
  buildIndexes(records);
  cachePromise = Promise.resolve();
}
