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
import { canonSku } from "../inventory-planning/utils/skuCanon";

export interface ItemMasterRecord {
  id: string;
  sku_code: string;
  style_code: string | null;
  color: string | null;
  size: string | null;
  description: string | null;
  // Master schema (verified against live ip_item_master): the planning side
  // labels `group_name` as "Category" and `category_name` as "Sub Cat".
  // `product_category` is a higher-level rollup (e.g. BOTTOMS / TOPS) we
  // don't currently surface. Variant rows (`sku_code !== style_code`) often
  // have an empty {} here; the populated attributes live on the style-level
  // row where `sku_code === style_code`.
  attributes: {
    group_name?: string | null;
    category_name?: string | null;
    product_category?: string | null;
    gender?: string | null;
  } | null;
}

export interface ResolvedStyle {
  category: string | null;       // attributes.group_name
  sub_category: string | null;   // attributes.sub_category_name
  style: string | null;          // style_code
  color: string | null;          // color
  size: string | null;           // size — primary PPK location (e.g. "PPK24")
  // Clean style-level description ("LAIDBACK Baggy Fit"). Variant rows
  // in Xoro carry a dirty composite ("LAIDBACK Baggy Fi RYB...-Harbor
  // - Med Wash-32-OCEAN HUT") that's the SKU code packed into the
  // description field. Resolver always returns the style-level row's
  // description so the grid + export show the clean form.
  description: string | null;
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
  size: null,
  description: null,
  match_source: null,
};

// Look up the clean description for a style. Variant rows
// (sku_code !== style_code) get their description from the style-
// level row when one exists; the variant's own description is the
// dirty composite Xoro packs in there. Returns null when no clean
// description exists anywhere.
function resolveCleanDescription(rec: ItemMasterRecord): string | null {
  if (rec.style_code) {
    const styleRow = byStyleCode?.get(rec.style_code.toUpperCase());
    const fromStyle = styleRow?.description?.trim();
    if (fromStyle) return fromStyle;
  }
  return rec.description?.trim() || null;
}

// A record is the "canonical" style-level row when its sku_code equals its
// style_code. Those rows carry the populated attributes (group_name etc.);
// variant rows (sku_code like "STYLE-COLOR") usually have attributes: {}.
function isStyleLevel(rec: ItemMasterRecord): boolean {
  return !!rec.style_code && rec.sku_code === rec.style_code;
}

// True when attributes has at least one populated metadata field. Prevents
// us from picking an empty-attributes variant when a populated row exists.
function hasMetadata(rec: ItemMasterRecord): boolean {
  const a = rec.attributes;
  if (!a) return false;
  return !!(a.group_name || a.category_name || a.product_category);
}

// Index: style_code (uppercase) → every variant id under that style.
// Used by callers that need to aggregate across all variants of a
// style (e.g. ATS export's T3 / SP-LY sales lookup, where the user's
// row might be at style grain while sales history is at variant
// grain). Distinct from `byStyleCode` which holds ONE preferred
// record per style for description / attribute lookup.
let idsByStyle: Map<string, string[]> | null = null;
// Index: `${UPPER(style_code)}|${UPPER(color)}` → every variant id
// matching that style + color. ATS rows are at style+color grain
// (no size dimension), but ip_sales_history_wholesale references
// per-size sku_ids — so an ATS row at color grain needs every size
// variant's id to aggregate sales across the whole color block.
let idsByStyleAndColor: Map<string, string[]> | null = null;
// Reverse lookup: ip_item_master.id → ItemMasterRecord. Used by the
// ATS export's cross-grid sales flow — when a customer has historical
// sales for a SKU that isn't currently visible in the grid, we need
// the master row's metadata (sku_code, style_code, color, description)
// to render a synthetic export row.
let byId: Map<string, ItemMasterRecord> | null = null;

function buildIndexes(records: ItemMasterRecord[]): void {
  const sku = new Map<string, ItemMasterRecord>();
  const style = new Map<string, ItemMasterRecord>();
  const idsByStyleLocal = new Map<string, string[]>();
  const idsByStyleAndColorLocal = new Map<string, string[]>();
  const byIdLocal = new Map<string, ItemMasterRecord>();
  for (const rec of records) {
    if (rec.id) byIdLocal.set(rec.id, rec);
    // Index by uppercase style+color so an ATS row at color grain
    // can find every size variant under it. Color may be null on
    // style-level rows; skip those — they're already covered by
    // idsByStyle.
    if (rec.id && rec.style_code && rec.color) {
      const key = `${rec.style_code.toUpperCase()}|${rec.color.trim().toUpperCase()}`;
      const list = idsByStyleAndColorLocal.get(key);
      if (list) list.push(rec.id);
      else idsByStyleAndColorLocal.set(key, [rec.id]);
    }
  }
  byId = byIdLocal;
  idsByStyleAndColor = idsByStyleAndColorLocal;
  for (const rec of records) {
    if (rec.sku_code) {
      // Index under three forms so the lookup hits regardless of
      // how the ATS row's SKU is shaped:
      //
      //   1. Raw sku_code as stored in the DB.
      //   2. Canonical form (uppercase, no whitespace) — covers ATS
      //      rows formatted with " - " separators ("RYO0822PPK - Black/Salsa")
      //      vs. the canonical write ("RYO0822PPK-BLACK/SALSA").
      //   3. PPK-suffix-stripped form — the master ingest writes some
      //      prepack rows with the size baked into the sku_code
      //      ("RYG1842PPK-BLACK-PPK60" or
      //      "RYO0822PPK-BLACK/SALSA-PPK18-BLACK/SALSA"). Xoro emits
      //      these as just the (style, color) pair without the size
      //      suffix, so we alias under the stripped form too. The
      //      regex strips a trailing "-PPKn" plus an optional final
      //      "-COLOR" tail for the variant-pass shape.
      //
      // Without (3), the unmatched-styles banner showed prepack rows
      // even though they were sitting in the master.
      sku.set(rec.sku_code, rec);
      const canonical = canonSku(rec.sku_code);
      if (canonical && canonical !== rec.sku_code && !sku.has(canonical)) {
        sku.set(canonical, rec);
      }
      const ppkStripped = canonical.replace(/-PPK[\s_-]*\d+(-[^-]*)?$/i, "");
      if (ppkStripped && ppkStripped !== canonical && !sku.has(ppkStripped)) {
        sku.set(ppkStripped, rec);
      }
    }
    if (rec.style_code) {
      // Case-insensitive style lookup: ATS SKUs sometimes carry the style
      // code in lowercase or mixed case, while master is canonically
      // uppercase. Index by uppercase key so the resolver can match
      // regardless of casing.
      const styleKey = rec.style_code.toUpperCase();
      const existing = style.get(styleKey);
      if (!existing || preferRec(rec, existing)) {
        style.set(styleKey, rec);
      }
      // Whitespace alias: store under the space-stripped uppercase key too
      // so an ATS row with the opposite spacing still hits. Only insert if
      // the stripped key isn't already taken by a primary record (don't
      // shadow a real master row).
      const styleKeyNoSpace = styleKey.replace(/\s+/g, "");
      if (styleKeyNoSpace !== styleKey && !style.has(styleKeyNoSpace)) {
        style.set(styleKeyNoSpace, style.get(styleKey)!);
      }
      // Collect every variant id under the style for cross-variant
      // aggregations.
      if (rec.id) {
        const list = idsByStyleLocal.get(styleKey);
        if (list) list.push(rec.id);
        else idsByStyleLocal.set(styleKey, [rec.id]);
        if (styleKeyNoSpace !== styleKey) {
          const list2 = idsByStyleLocal.get(styleKeyNoSpace);
          if (list2) list2.push(rec.id);
          else idsByStyleLocal.set(styleKeyNoSpace, [rec.id]);
        }
      }
    }
  }
  bySkuCode = sku;
  byStyleCode = style;
  idsByStyle = idsByStyleLocal;
}

// Decide whether `cand` should replace `incumbent` for a style key. Priority:
// 1. Has populated attributes (the metadata is what the grid renders)
// 2. Is the canonical style-level row (sku_code === style_code)
// 3. Lexicographically smallest sku_code (deterministic tie-break)
function preferRec(cand: ItemMasterRecord, incumbent: ItemMasterRecord): boolean {
  const candMeta = hasMetadata(cand);
  const incMeta = hasMetadata(incumbent);
  if (candMeta !== incMeta) return candMeta;
  const candStyleLevel = isStyleLevel(cand);
  const incStyleLevel = isStyleLevel(incumbent);
  if (candStyleLevel !== incStyleLevel) return candStyleLevel;
  return cand.sku_code < incumbent.sku_code;
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

  // Try both forms: the master's canonical key (uppercase no-space)
  // and the human-readable normalized form (kept as fallback for any
  // legacy rows that didn't go through the canonSku ingest path).
  // canonSku FIRST because the current master ingest writes canonical
  // sku_codes — that's the path we expect to hit.
  const canonicalSku = canonSku(sku);
  const normalizedSku = normalizeSku(sku);
  const skuHit = bySkuCode.get(canonicalSku) ?? bySkuCode.get(normalizedSku);
  if (skuHit) {
    return {
      category: skuHit.attributes?.group_name ?? null,
      // Planning labels `category_name` as "Sub Cat" — match its convention.
      sub_category: skuHit.attributes?.category_name ?? null,
      style: skuHit.style_code ?? null,
      color: skuHit.color ?? null,
      size: skuHit.size ?? null,
      description: resolveCleanDescription(skuHit),
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
          // Planning labels `category_name` as "Sub Cat" — match its convention.
          sub_category: styleHit.attributes?.category_name ?? null,
          style: styleHit.style_code ?? null,
          color: styleHit.color ?? null,
          // Style-level master row typically has no size — variant rows
          // do. PPK detection will fall back to SKU/desc for these.
          size: styleHit.size ?? null,
          description: resolveCleanDescription(styleHit),
          match_source: "style",
        };
      }
    }
  }

  return { ...NULL_RESULT };
}

/** True once the master cache has been built (regardless of whether
 *  any rows were loaded). Lets callers distinguish "cache empty
 *  because it hasn't loaded yet" from "cache empty because the table
 *  is genuinely empty" so they can defer noisy warnings. */
export function isItemMasterLoaded(): boolean {
  return bySkuCode !== null && byStyleCode !== null;
}

/**
 * Returns every ip_item_master.id that could be the underlying record
 * for an ATS row. Use this when looking up data keyed by sku_id
 * (sales history, snapshots, etc.) — at variant grain you get one id
 * back; at style grain you get one id per color/size variant of that
 * style so the caller can sum across them.
 *
 * Lookup order:
 *   1. Variant-level by canonical sku_code (then normalized fallback)
 *   2. Style-level: every variant id under stylePart's uppercase key
 *
 * Returns [] if the cache isn't loaded or nothing matched.
 */
export function resolveItemMasterIds(sku: string, stylePart?: string | null): string[] {
  if (!bySkuCode || !idsByStyle) return [];

  const canonicalSku = canonSku(sku);
  const normalizedSku = normalizeSku(sku);
  const skuHit = bySkuCode.get(canonicalSku) ?? bySkuCode.get(normalizedSku);
  if (skuHit?.id) {
    // The matched record is typically the color-level canonical row
    // (sku_code = style + color). ATS rows are at color grain, but
    // ip_sales_history_wholesale references per-SIZE variant uuids.
    // Expand to every variant under (style_code, color) so the
    // grid row aggregates the whole color block's sales.
    if (skuHit.style_code && skuHit.color && idsByStyleAndColor) {
      const key = `${skuHit.style_code.toUpperCase()}|${skuHit.color.trim().toUpperCase()}`;
      const family = idsByStyleAndColor.get(key);
      if (family && family.length) {
        const set = new Set<string>(family);
        set.add(skuHit.id);
        return [...set];
      }
    }
    return [skuHit.id];
  }

  if (stylePart) {
    const trimmedUpper = stylePart.trim().toUpperCase();
    if (trimmedUpper) {
      const direct = idsByStyle.get(trimmedUpper);
      if (direct && direct.length) return direct;
      const noSpace = trimmedUpper.replace(/\s+/g, "");
      if (noSpace !== trimmedUpper) {
        const stripped = idsByStyle.get(noSpace);
        if (stripped && stripped.length) return stripped;
      }
    }
  }

  return [];
}

/** Visible for tests + cache invalidation after the user adds new
 *  master rows in the planning app. Next `loadItemMasterCache()` call
 *  refetches. */
export function clearItemMasterCache(): void {
  cachePromise = null;
  bySkuCode = null;
  byStyleCode = null;
  idsByStyle = null;
  idsByStyleAndColor = null;
  byId = null;
}

/**
 * Returns the cached ItemMasterRecord for an ip_item_master.id, or
 * null if the cache isn't loaded or the id isn't known. Used by the
 * ATS export to build synthetic rows for SKUs that have customer
 * sales history but no presence in the current grid.
 */
export function getItemMasterById(id: string): ItemMasterRecord | null {
  return byId?.get(id) ?? null;
}

/** Visible for tests — inject a pre-built cache without hitting
 *  Supabase. Sets `cachePromise` to a resolved Promise so subsequent
 *  `loadItemMasterCache()` calls become no-ops. */
export function __setCacheForTest(records: ItemMasterRecord[]): void {
  buildIndexes(records);
  cachePromise = Promise.resolve();
}
