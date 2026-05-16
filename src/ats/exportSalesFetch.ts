// Sales-history fetch + aggregation for the ATS Excel export's
// Trailing-3 and Same-Period-Last-Year columns.
//
// Source of truth: ip_sales_history_wholesale — populated by the
// nightly Xoro sales sync. The in-app eventIndex (built from operator-
// uploaded All Orders Xoro CSV) only carries OPEN commitments, so T3
// and SP LY can't use it for actual shipped sales. See the workflow
// memory feedback_nightly_db_source.md for the policy.

import { SB_URL, SB_HEADERS } from "../utils/supabase";
import type { ATSRow } from "./types";
import { resolveStyle, isItemMasterLoaded } from "./itemMasterLookup";

interface SalesRow {
  sku_id: string;
  customer_id: string | null;
  txn_date: string;        // YYYY-MM-DD
  qty: number | string;
  net_amount: number | string | null;
  unit_price: number | string | null;
}

// Per-SKU aggregate over a date window: total qty + total revenue.
export interface SalesAggregate {
  qty: number;
  totalPrice: number;
}

// Aggregates keyed by ATS row's `sku` string (variant-level SKU as the
// row carries it — same key the rest of exportExcel uses).
export type SalesAggMap = Map<string, SalesAggregate>;

export interface SalesFetchResult {
  t3: SalesAggMap;
  ly: SalesAggMap;
}

// Subtract `months` calendar months from an ISO date.
function isoMinusMonths(iso: string, months: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Resolve "today" as YYYY-MM-DD in local time (matches the date column
// in the DB, which is plain DATE).
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function sbGet<T>(path: string): Promise<T[]> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`sales fetch ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Paginated PostgREST walk. Default page is 1000 rows; this table can
// hit 50k+ rows for a 15-month window so we walk in chunks.
async function sbGetAll<T>(pathWithoutLimit: string, pageSize = 1000): Promise<T[]> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const out: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const sep = pathWithoutLimit.includes("?") ? "&" : "?";
    const url = `${SB_URL}/rest/v1/${pathWithoutLimit}${sep}limit=${pageSize}&offset=${offset}`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) throw new Error(`sales fetch ${url} failed: ${r.status} ${await r.text()}`);
    const chunk = (await r.json()) as T[];
    out.push(...chunk);
    if (chunk.length < pageSize) break;
    if (offset > 1_000_000) break;
  }
  return out;
}

function toNum(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Resolve a customer name to a customer_id via ip_customer_master.
// Returns null if no exact name match is found — caller treats that as
// "no rows" rather than "all customers" so we don't accidentally
// surface every customer's data when the user picked one that doesn't
// match the master.
async function resolveCustomerId(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const enc = encodeURIComponent(trimmed);
  const rows = await sbGet<{ id: string }>(
    `ip_customer_master?select=id&name=eq.${enc}&limit=1`,
  );
  return rows[0]?.id ?? null;
}

// Build a map: ip_item_master.id (uuid) → ATS-row sku string. Uses the
// already-loaded itemMasterLookup cache. Each ATS row may resolve to
// either a variant-level master record (sku_code === row.sku) or a
// style-level one (matched via the row.sku's style part). Either way
// the uuid that lands in sales-history.sku_id will hit this map.
function buildItemIdToRowSku(rows: ATSRow[]): Map<string, string> {
  const map = new Map<string, string>();
  if (!isItemMasterLoaded()) return map;
  for (const row of rows) {
    const spaceDelim = row.sku.indexOf(" - ");
    const stylePart = spaceDelim !== -1 ? row.sku.slice(0, spaceDelim).trim() : row.sku.trim();
    const resolved = resolveStyle(row.sku, stylePart || null);
    // resolveStyle returns the resolved record's id via match_source —
    // need the actual id. Look it up off the record once resolved.
    // The lookup module exposes match metadata but not the id directly
    // on ResolvedStyle, so we fall back to a second lookup.
    // Use the canonical sku_code path: if the row resolved by-sku, the
    // first variant lookup will give us the record. By-style resolves
    // to the chosen variant for that style.
    const id = resolveSkuToId(row.sku, stylePart);
    if (id && !map.has(id)) map.set(id, row.sku);
  }
  return map;
}

// Walk the master cache to find the id for a row's sku/stylePart.
// Mirrors the matching logic in resolveStyle but returns the id.
// Kept here (rather than added to itemMasterLookup) to avoid coupling
// the master module to one consumer's needs.
function resolveSkuToId(sku: string, stylePart: string | null): string | null {
  // resolveStyle returns { match_source: 'sku' | 'style' | null }. When
  // by-sku, the record's id is keyed by `sku` exactly. When by-style,
  // the resolved record is the canonical row for the style. The
  // itemMasterLookup module's internal indexes aren't exported, so we
  // fetch a single row via the REST endpoint as the simplest reliable
  // path. This runs once per unique sku at export time — acceptable for
  // the 100-2000 row scale of typical ATS exports.
  //
  // (If this ever becomes a hot path, expose the master indexes from
  // itemMasterLookup and lookup in-memory instead.)
  void stylePart; // unused — resolveSkuToId currently relies on the REST round-trip
  return _idCache.get(sku) ?? null;
}

// In-memory id cache populated by primeIdCache(). Keyed by ATS sku
// string. The export flow calls primeIdCache() once before walking
// rows so resolveSkuToId is synchronous and cheap.
const _idCache = new Map<string, string>();

// Look up every ATS row's master id in one round trip and stash in the
// cache. Falls back to style-level lookup when the variant sku doesn't
// match an ip_item_master row directly.
async function primeIdCache(rows: ATSRow[]): Promise<void> {
  _idCache.clear();
  const uniqueSkus = new Set<string>();
  const uniqueStyles = new Set<string>();
  for (const r of rows) {
    if (!r.sku) continue;
    uniqueSkus.add(r.sku);
    const spaceDelim = r.sku.indexOf(" - ");
    if (spaceDelim !== -1) {
      const sp = r.sku.slice(0, spaceDelim).trim();
      if (sp) uniqueStyles.add(sp);
    } else {
      uniqueStyles.add(r.sku.trim());
    }
  }
  if (uniqueSkus.size === 0) return;

  // Fetch variant-level matches first.
  const skuList = [...uniqueSkus].map(s => `"${s.replace(/"/g, '\\"')}"`).join(",");
  const variantRows = await sbGet<{ id: string; sku_code: string }>(
    `ip_item_master?select=id,sku_code&sku_code=in.(${encodeURIComponent(skuList)})`,
  );
  for (const v of variantRows) {
    if (v.sku_code) _idCache.set(v.sku_code, v.id);
  }

  // For ATS rows that didn't match by variant sku, try style_code.
  const stillMissing = [...uniqueSkus].filter(s => !_idCache.has(s));
  if (stillMissing.length === 0) return;

  const stylesNeeded = new Set<string>();
  const skuToStyle = new Map<string, string>();
  for (const sku of stillMissing) {
    const spaceDelim = sku.indexOf(" - ");
    const sp = spaceDelim !== -1 ? sku.slice(0, spaceDelim).trim() : sku.trim();
    if (sp) {
      stylesNeeded.add(sp);
      skuToStyle.set(sku, sp);
    }
  }
  if (stylesNeeded.size === 0) return;
  const styleList = [...stylesNeeded].map(s => `"${s.replace(/"/g, '\\"')}"`).join(",");
  // Pull style→id mapping. Style rows in ip_item_master typically have
  // sku_code === style_code (canonical style record); use that as the
  // representative id.
  const styleRows = await sbGet<{ id: string; sku_code: string; style_code: string | null }>(
    `ip_item_master?select=id,sku_code,style_code&style_code=in.(${encodeURIComponent(styleList)})&order=sku_code.asc`,
  );
  const styleToId = new Map<string, string>();
  for (const r of styleRows) {
    if (!r.style_code) continue;
    // Prefer the canonical row (sku_code === style_code) when multiple
    // variants share the style.
    const isCanonical = r.sku_code === r.style_code;
    if (isCanonical || !styleToId.has(r.style_code)) {
      styleToId.set(r.style_code, r.id);
    }
  }
  for (const sku of stillMissing) {
    const style = skuToStyle.get(sku);
    if (!style) continue;
    const id = styleToId.get(style);
    if (id) _idCache.set(sku, id);
  }
}

// Aggregate raw sales rows into a per-ATS-sku map. Skips rows whose
// sku_id we couldn't map back to an ATS row (e.g. sales for a SKU not
// in the current export's filter).
function aggregate(salesRows: SalesRow[], idToSku: Map<string, string>): SalesAggMap {
  const out: SalesAggMap = new Map();
  for (const r of salesRows) {
    const atsSku = idToSku.get(r.sku_id);
    if (!atsSku) continue;
    const qty = toNum(r.qty);
    // net_amount preferred (Xoro net of discounts); fall back to
    // unit_price × qty if the column is null on a given row.
    let rev = toNum(r.net_amount);
    if (rev <= 0) rev = toNum(r.unit_price) * qty;
    const ex = out.get(atsSku);
    if (ex) {
      ex.qty += qty;
      ex.totalPrice += rev;
    } else {
      out.set(atsSku, { qty, totalPrice: rev });
    }
  }
  return out;
}

export interface FetchSalesArgs {
  rows: ATSRow[];
  // Both flags drive whether we fetch the corresponding window. If
  // both are false, returns empty maps without hitting the network.
  needT3: boolean;
  needLY: boolean;
  // Optional customer name (typed exactly as it appears in
  // ip_customer_master.name). Empty = no customer filter.
  customer: string;
}

// Fetch + aggregate sales for the ATS export. One round trip for the
// widest needed date window, then bucket in-memory into T3 (last 3
// months from today) and LY (3 months ending 12 months ago).
export async function fetchSalesAggregates({ rows, needT3, needLY, customer }: FetchSalesArgs): Promise<SalesFetchResult> {
  if (!needT3 && !needLY) {
    return { t3: new Map(), ly: new Map() };
  }
  if (!SB_URL) {
    console.warn("[ATS export] Supabase not configured — T3/LY columns will be empty.");
    return { t3: new Map(), ly: new Map() };
  }

  const today = todayIso();
  const t3Start = isoMinusMonths(today, 3);
  const lyEnd   = isoMinusMonths(today, 12);
  const lyStart = isoMinusMonths(today, 15);

  // Widest fetch window that covers both. If only one is needed we
  // narrow to just that window to save bandwidth.
  let fetchStart: string;
  let fetchEnd: string;
  if (needT3 && needLY) { fetchStart = lyStart; fetchEnd = today; }
  else if (needT3)      { fetchStart = t3Start; fetchEnd = today; }
  else                  { fetchStart = lyStart; fetchEnd = lyEnd; }

  // Resolve customer name → id once.
  let customerClause = "";
  if (customer) {
    const cid = await resolveCustomerId(customer);
    if (!cid) {
      // Unknown customer → no sales to fetch.
      return { t3: new Map(), ly: new Map() };
    }
    customerClause = `&customer_id=eq.${cid}`;
  }

  // Prime the id-cache for SKU → uuid mapping.
  await primeIdCache(rows);
  if (_idCache.size === 0) {
    console.warn("[ATS export] no ATS rows resolved to ip_item_master — T3/LY empty.");
    return { t3: new Map(), ly: new Map() };
  }

  // Sales rows in the window. We could narrow with sku_id=in.(...) but
  // the URL gets long fast for big exports (1000s of SKUs); date-window
  // alone is a manageable fetch.
  const path = `ip_sales_history_wholesale?select=sku_id,customer_id,txn_date,qty,net_amount,unit_price&txn_date=gte.${fetchStart}&txn_date=lte.${fetchEnd}${customerClause}&order=txn_date.asc`;
  const salesRows = await sbGetAll<SalesRow>(path, 500);

  // Build the reverse map: ip_item_master.id → ATS row sku.
  const idToSku = new Map<string, string>();
  for (const [atsSku, id] of _idCache) idToSku.set(id, atsSku);

  // Bucket by window.
  const t3Rows: SalesRow[] = [];
  const lyRows: SalesRow[] = [];
  for (const r of salesRows) {
    if (needT3 && r.txn_date >= t3Start && r.txn_date <= today)  t3Rows.push(r);
    if (needLY && r.txn_date >= lyStart && r.txn_date <= lyEnd)  lyRows.push(r);
  }

  return {
    t3: needT3 ? aggregate(t3Rows, idToSku) : new Map(),
    ly: needLY ? aggregate(lyRows, idToSku) : new Map(),
  };
}
