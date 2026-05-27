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
import { isItemMasterLoaded, loadItemMasterCache, resolveItemMasterIds, getMatchingItemMasterIds, getItemMasterById } from "./itemMasterLookup";

interface SalesRow {
  sku_id: string;
  customer_id: string | null;
  // channel_id: ip_channel_master row. Populated by the nightly sync
  // for rows ingested after migration 20260518030000; NULL for older
  // historical rows. Export's store filter respects this — NULL rows
  // are excluded when a specific store is selected (operator must
  // re-run nightly to backfill channel_id on rolling window).
  channel_id: string | null;
  txn_date: string;        // YYYY-MM-DD
  qty: number | string;
  // qty_units: authoritative unit-grain qty. Populated by the nightly
  // sync handler since migration 20260517230000. NULL for legacy rows
  // and for rows from non-nightly write paths (xoro-sales-sync,
  // excelIngestService) until those are updated — we COALESCE to qty.
  qty_units: number | string | null;
  net_amount: number | string | null;
  unit_price: number | string | null;
  // margin_amount: server-computed margin $ per row (net - units*cost).
  // NULL when net_amount or unit_cost_at_sale missing. Operators see a
  // blank margin cell rather than a wrong-grain recomputation.
  margin_amount: number | string | null;
}

// Per-SKU aggregate over a date window: total qty + total revenue +
// total margin $ (so the export can compute margin % = margin / revenue
// without re-doing per-unit cost math).
export interface SalesAggregate {
  qty: number;
  totalPrice: number;
  // Sum of margin_amount across the aggregated rows. May be 0 if every
  // row had a NULL margin (legacy / non-nightly path). Compute margin %
  // = marginAmount / totalPrice; suppress when totalPrice is 0.
  marginAmount: number;
}

// Aggregates keyed by ATS row's `sku` string (variant-level SKU as the
// row carries it — same key the rest of exportExcel uses).
export type SalesAggMap = Map<string, SalesAggregate>;

// Per-customer rollup. Same TY/LY shape as the per-SKU aggregates,
// only at customer_id grain. Populated when the caller passes
// needByCustomer:true to fetchSalesAggregates. customerName is
// resolved post-aggregation via a single batched ip_customer_master
// lookup. NULL customer_id (rare; legacy / Xoro-side data gap) is
// bucketed under the magic key "__unknown".
//
// bySku is the per-(customer, sku_id) breakdown of the same TY+LY
// windows. Required by the customer dim's grain-aware aggregator —
// a customer's qty can mix PPK and each grains, and the modal needs
// per-SKU detail to classify + split (or collapse) per the explodePpk
// toggle. Built in the same row scan as t3/ly (no extra DB round
// trip). Keyed by ip_item_master.id (uuid) — the caller resolves
// id → sku_code via the in-memory item-master cache.
export interface CustomerSkuAgg {
  t3: SalesAggregate;
  ly: SalesAggregate;
}
export interface CustomerRollupEntry {
  customerName: string;
  t3: SalesAggregate;
  ly: SalesAggregate;
  bySku: Map<string, CustomerSkuAgg>;
}
export type CustomerRollup = Map<string, CustomerRollupEntry>;

export interface SalesFetchResult {
  // Actual windows used (default or custom). Caller uses these to
  // render column headers + skip rows with no history in either.
  windows: SalesFetchWindows;
  t3: SalesAggMap;
  ly: SalesAggMap;
  // Per-sku_id aggregate for sales rows whose sku_id didn't map to
  // any current ATS row. Used by the export's cross-grid mode — when
  // a customer has historical sales for a SKU that isn't visible in
  // the grid right now (e.g. inventory shipped through, no open
  // orders left), we still want it to appear in the report so the
  // operator can see the customer's full purchase history. Keyed by
  // ip_item_master.id (uuid).
  extraBySkuId: Map<string, SalesAggregate & {
    lyQty: number; lyTotal: number; lyMargin: number;
    t3Qty: number; t3Total: number; t3Margin: number;
  }>;
  // Per-customer rollup. Present only when the caller asked for it
  // (needByCustomer:true). Keyed by customer_id; entry.customerName
  // is the display name from ip_customer_master.
  byCustomer?: CustomerRollup;
  // Per-style daily LY breakdown. Present only when needLyDailyByStyle
  // is set. Map<style_code, Array<{date, qty, totalPrice, marginAmount}>>
  // sorted by date ascending. Multiple sales of the same style on the
  // same date are summed into one entry. Used by the Sales Comps SO
  // view to compute a per-SO LY window (cancel_date ± 30d shifted -12mo)
  // instead of every SO row carrying the same full-window style total.
  // The fetch's LY window is widened by ±30 days when this flag is set
  // so every per-SO window is covered.
  lyDailyByStyle?: Map<string, DailyStyleAgg[]>;
  // Per-style T3 aggregate. Keyed by ip_item_master.style_code.
  // Present only when needT3ByStyle is set. Lets the Mrgn % column
  // derive a style-level avg sell price = totalPrice / qty.
  t3ByStyle?: Map<string, SalesAggregate>;
  // Per-ATS-sku most-recent unit_price within the last 12 months.
  // Present only when needLastCustomerPriceBySku is set. When a
  // customer is selected upstream, salesRows are already customer-
  // filtered, so the resulting price is THAT customer's most recent
  // buy of the SKU.
  lastCustomerPriceBySku?: Map<string, { price: number; date: string }>;
}

// One day of LY sales for a single style. Built from ip_sales_history_wholesale
// during the same row scan that produces `t3` / `ly`. The array form (sorted
// by date) lets the SO view scan a per-SO window with a single pass.
export interface DailyStyleAgg {
  date: string;        // YYYY-MM-DD
  qty: number;
  totalPrice: number;
  marginAmount: number;
}

// ── Module-level cache of the wide (15-month) sales-history window ───
// Primed at app start by preloadSalesHistory() so the first export
// View / Download doesn't pay the multi-second round trip. fetched
// rows are reused across customer / window combinations — the
// aggregation step is in-memory and cheap.
let salesCachePromise: Promise<SalesRow[]> | null = null;
let salesCacheRows: SalesRow[] | null = null;
let salesCacheStart: string | null = null;
let salesCacheEnd: string | null = null;

function isoMinusMonths(iso: string, months: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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

// Add `days` to an ISO date (YYYY-MM-DD), returning a new ISO date.
function isoPlusDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Compute N+1 evenly-spaced date boundaries between start and end
// inclusive. boundaries[0] === start, boundaries[N] === end. Used to
// split the sales-history window into N parallel slices.
function sliceBoundaries(start: string, end: string, slices: number): string[] {
  const startD = new Date(start + "T00:00:00").getTime();
  const endD = new Date(end + "T00:00:00").getTime();
  const out: string[] = [start];
  for (let i = 1; i < slices; i++) {
    const t = startD + Math.round((endD - startD) * (i / slices));
    const d = new Date(t);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  out.push(end);
  return out;
}

// Fetch one date-range slice in parallel-friendly chunks. Internal
// slices use gte/lt (half-open) so adjacent slices don't double-count
// the boundary day; the caller's final slice covers through `end`
// inclusive by passing endExclusive = end + 1 day.
async function fetchSalesSlice(startInclusive: string, endExclusive: string, pageSize = 1000): Promise<SalesRow[]> {
  const cols = "sku_id,customer_id,channel_id,txn_date,qty,qty_units,net_amount,unit_price,margin_amount";
  const path = `ip_sales_history_wholesale?select=${cols}&txn_date=gte.${startInclusive}&txn_date=lt.${endExclusive}&order=txn_date.asc`;
  return sbGetAll<SalesRow>(path, pageSize);
}

function toNum(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Canonicalize a customer name the way the Xoro sales-invoice sync
// does (uppercase + collapse whitespace). Used to compare the
// operator-typed dropdown value against ip_customer_master.name when
// the punctuation/case/whitespace doesn't line up.
function canonCustomerName(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

// Returns every ip_customer_master.id whose name matches the given
// dropdown value under any reasonable interpretation. Worth being
// aggressive: the dropdown's source is the operator's upload
// (excelData.sos.customerName), and ip_customer_master.name was
// written by the Xoro sales sync after its own canonicalization —
// they often diverge ("Ross Procurement" vs "ROSS PROCUREMENT" vs
// "Ross Procurement, Inc."). Returns empty array if no candidate
// passes the canonicalized comparison.
async function resolveCustomerIds(name: string): Promise<string[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const target = canonCustomerName(trimmed);

  // Pull a candidate pool with a generous ILIKE on the first
  // meaningful token (Xoro often appends ", Inc." or "DC #..." to
  // the same logical customer). Big-box retailers can have 50+
  // separate DC rows — Burlington at 80+ live entries silently
  // truncated under the old limit=50 and sales tied to the missed
  // IDs vanished from T3/LY. Use sbGetAll so PostgREST's
  // db-max-rows=1000 cap can't truncate us either.
  const firstWord = trimmed.split(/\s+/)[0] || trimmed;
  const enc = encodeURIComponent(`${firstWord}%`);
  const rows = await sbGetAll<{ id: string; name: string }>(
    `ip_customer_master?select=id,name&name=ilike.${enc}&order=name.asc`,
  );

  const out: string[] = [];
  for (const r of rows) {
    if (!r.id || !r.name) continue;
    const candidate = canonCustomerName(r.name);
    if (
      candidate === target
      || candidate.startsWith(target)
      || target.startsWith(candidate)
    ) {
      out.push(r.id);
    }
  }
  // Also try an exact match in case the first-word pool missed it
  // (e.g. operator typed the full name verbatim).
  if (out.length === 0) {
    const encExact = encodeURIComponent(trimmed);
    const exact = await sbGet<{ id: string }>(
      `ip_customer_master?select=id&name=eq.${encExact}&limit=5`,
    );
    for (const r of exact) if (r.id) out.push(r.id);
  }
  return out;
}

// Module-level cache of channel_code -> channel_id, so the store
// filter resolves with one Supabase round-trip per app session.
// Channels are static — refreshing on demand isn't worth the cost.
let channelCacheMap: Map<string, string> | null = null;
let channelCachePromise: Promise<Map<string, string>> | null = null;

async function loadChannelMap(): Promise<Map<string, string>> {
  if (channelCacheMap) return channelCacheMap;
  if (channelCachePromise) return channelCachePromise;
  channelCachePromise = (async () => {
    const rows = await sbGet<{ id: string; channel_code: string }>(
      `ip_channel_master?select=id,channel_code`,
    );
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.id && r.channel_code) m.set(r.channel_code, r.id);
    }
    channelCacheMap = m;
    return m;
  })();
  return channelCachePromise;
}

async function resolveChannelIds(codes: string[]): Promise<Set<string>> {
  const map = await loadChannelMap();
  const out = new Set<string>();
  for (const code of codes) {
    if (code === "All") continue;
    const id = map.get(code);
    if (id) out.add(id);
  }
  return out;
}


// Build the variant-id → ATS-sku reverse map. Walks each ATS row,
// resolves it to one or more ip_item_master.id values via the existing
// item-master cache (which handles canonicalization, PPK suffix
// aliasing, style-level fallback). Multiple ids may map to the same
// ATS sku when the row is at style grain.
//
// Earlier versions recorded per-id ppkMult so the aggregator could
// convert pack-grain to unit-grain at ingest. Reverted because Xoro's
// sales-history grain is not reliably pack-vs-unit across records —
// dirty master size data was triggering over-multiplication. Sales
// columns now mirror Xoro's recorded grain per SKU; the grid's
// Explode-PPK toggle only affects ATS columns.
function buildIdToSkuMap(rows: ATSRow[]): { idToSku: Map<string, string>; matched: number; unmatched: number } {
  const idToSku = new Map<string, string>();
  let matched = 0;
  let unmatched = 0;
  for (const row of rows) {
    if (!row.sku) continue;
    const spaceDelim = row.sku.indexOf(" - ");
    const stylePart = spaceDelim !== -1 ? row.sku.slice(0, spaceDelim).trim() : row.sku.trim();
    const ids = resolveItemMasterIds(row.sku, stylePart || null);
    if (ids.length === 0) {
      unmatched++;
      continue;
    }
    matched++;
    for (const id of ids) {
      if (!idToSku.has(id)) idToSku.set(id, row.sku);
    }
  }
  return { idToSku, matched, unmatched };
}

export interface FetchSalesArgs {
  rows: ATSRow[];
  needT3: boolean;
  needLY: boolean;
  // Single customer name OR an array of customer names (multi-select).
  // Empty string / empty array = "all customers". When multiple names
  // are provided, each is resolved to its ip_customer_master.id set
  // independently and the union is used to filter the sales rows.
  customer: string | string[];
  // Store filter — array of channel_code strings ("ROF", "ROF ECOM",
  // "PT"). When provided and not ["All"], the sales fetch narrows to
  // rows whose channel_id matches one of the resolved channels. Rows
  // with NULL channel_id (legacy / pre-migration data) are excluded
  // from any store-specific filter.
  storeFilter?: string[];
  // On-screen non-store filters. When any of these is non-empty, the
  // sales aggregation is unhooked from the grid's visible-SKU set and
  // re-keyed off the union of "SKUs whose master row matches these
  // filters" + "SKUs in the grid". Without this, cross-store totals
  // don't reconcile because the grid's store-tag restriction silently
  // drops the wholesale sales of SKUs whose only grid presence is via
  // ECOM-tagged POs. See project_ats_export_grain_handoff_2026_05_18.
  filterCategory?: string[];
  filterSubCategory?: string[];
  filterStyle?: string[];
  filterGender?: string[];
  // Optional custom window for the T3 block. When provided, T3
  // aggregates use [customStart, customEnd] instead of the default
  // "last 3 months from today", and SP LY uses the same window shifted
  // back 12 months. Caller is responsible for validating start <= end;
  // we treat dates outside the cached 15-month preload as a cache miss
  // and fall through to directFetch.
  customStart?: string; // YYYY-MM-DD
  customEnd?: string;   // YYYY-MM-DD
  // When true, the result includes a `byCustomer` rollup. One
  // additional batched ip_customer_master lookup after the row scan
  // — no extra sales-history round trip.
  needByCustomer?: boolean;
  // When true, the result includes `lyDailyByStyle` — a per-(style, day)
  // breakdown of LY sales so callers can compute per-SO LY windows
  // (e.g. cancel_date - 12mo ± 30d). Widens the LY fetch by 30 days
  // on each side so every per-SO window is fully covered. Built in
  // the same row scan as t3/ly — no extra DB round trip.
  needLyDailyByStyle?: boolean;
  // When true, the result includes `t3ByStyle` — T3-window sales
  // aggregated to ip_item_master.style_code. Used by the Sls Prc
  // Mrgn % column to derive a style-level avg sell price when the
  // formula path would otherwise just echo the operator's typed
  // margin. Honors the customer filter (when set) so the style
  // price reflects that customer's T3 buys.
  needT3ByStyle?: boolean;
  // When true, the result includes `lastCustomerPriceBySku` — the
  // most-recent unit_price per ATS-row sku within the last 12 months.
  // Only useful when a customer is selected (rows are customer-
  // filtered upstream). Used by the Sls Prc Mrgn % column to override
  // the formula with the customer's most recent actual sale price.
  needLastCustomerPriceBySku?: boolean;
}

export interface SalesFetchWindows {
  t3Start: string;
  t3End:   string;
  lyStart: string;
  lyEnd:   string;
}

// Kick off (or return the in-flight Promise for) the full sales-
// history fetch. Safe to call multiple times — concurrent callers
// share one round trip. Failures clear the cached Promise so the
// next call retries.
//
// Called from ATS.tsx mount alongside loadItemMasterCache so the data
// is warm by the time the operator clicks Export Excel.
//
// History scope: the cache covers every txn from the table's actual
// earliest date through today. Previously this was a rolling 15-month
// window which silently truncated custom date ranges that reached back
// further (user report: LY block needed 2025-01-01 but preload only
// started 2025-02-19, dropping $2M of revenue from totals).
//
// We dynamically query MIN(txn_date) at preload time so the cache
// always covers every operator-pickable range without wasting slices
// on years of empty data. PRELOAD_FALLBACK_START is used only if the
// MIN query fails — set well before the earliest plausible ingest.
const PRELOAD_FALLBACK_START = "2020-01-01";

// Returns the table's earliest txn_date (YYYY-MM-DD), or the fallback
// if the query fails / the table is empty. Cheap — a single indexed
// MIN aggregation finishes in well under 100ms.
async function fetchEarliestTxnDate(): Promise<string> {
  if (!SB_URL) return PRELOAD_FALLBACK_START;
  try {
    const url = `${SB_URL}/rest/v1/ip_sales_history_wholesale?select=txn_date&order=txn_date.asc&limit=1`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) return PRELOAD_FALLBACK_START;
    const rows = (await r.json()) as Array<{ txn_date: string }>;
    if (!rows.length || !rows[0].txn_date) return PRELOAD_FALLBACK_START;
    return rows[0].txn_date;
  } catch {
    return PRELOAD_FALLBACK_START;
  }
}

export function preloadSalesHistory(): Promise<SalesRow[]> {
  if (salesCachePromise) return salesCachePromise;
  if (!SB_URL) {
    console.warn("[sales preload] Supabase not configured — skipping.");
    return Promise.resolve([]);
  }

  const today = todayIso();

  salesCachePromise = (async () => {
    const t0 = performance.now();
    try {
      // Query the actual earliest txn_date so the 5 parallel slices
      // cover ONLY the populated range. A fixed 2020-01-01 floor was
      // spending round trips on 4 years of empty slices, measurably
      // slowing cold load even though each empty slice is just one
      // request — they still serialize the slice-promise array and
      // add latency to the slowest parallel branch.
      const start = await fetchEarliestTxnDate();

      // Parallel-fetch in 5 evenly-spaced slices. With slices covering
      // only populated dates, each gets ~9k rows = ~9 round trips at
      // page=1000 = ~5s parallel. Keeps each slice's offset well under
      // the 57014 statement-timeout threshold observed at offset 16k+.
      const SLICES = 5;
      const PAGE_SIZE = 1000;
      const boundaries = sliceBoundaries(start, today, SLICES);

      const slicePromises: Promise<SalesRow[]>[] = [];
      for (let i = 0; i < boundaries.length - 1; i++) {
        const sliceStart = boundaries[i];
        // Half-open (gte/lt) so adjacent slices never double-count the
        // boundary day. Final slice's exclusive end is day-after-today
        // so today is included.
        const isLast = i === boundaries.length - 2;
        const sliceEnd = isLast ? isoPlusDays(boundaries[i + 1], 1) : boundaries[i + 1];
        slicePromises.push(fetchSalesSlice(sliceStart, sliceEnd, PAGE_SIZE));
      }
      const sliceResults = await Promise.all(slicePromises);
      const rows = sliceResults.flat();
      salesCacheRows  = rows;
      salesCacheStart = start;
      salesCacheEnd   = today;
      const ms = Math.round(performance.now() - t0);
      console.info(`[sales preload] cached ${rows.length} rows for ${start}..${today} in ${ms}ms (${SLICES} parallel slices)`);
      return rows;
    } catch (e) {
      salesCachePromise = null;
      console.error("[sales preload] failed:", e);
      throw e;
    }
  })();
  return salesCachePromise;
}

// True when the cached window covers the requested range. Cache is
// pinned to "today" at preload time so a fetcher invoked the next day
// might find the cache stale by one day — still usable for T3/LY
// (whose windows shift only at month boundaries in practice). We
// invalidate only when the cache's window actually doesn't cover.
function cacheCovers(start: string, end: string): boolean {
  if (!salesCacheRows || !salesCacheStart || !salesCacheEnd) return false;
  return start >= salesCacheStart && end <= salesCacheEnd;
}

// LY widening for the per-style daily LY map. The Sales Comps SO view
// compares each open SO against shipments of the same style in a ±30d
// window around the SO's cancel date shifted -12mo — so the fetched
// LY range must extend 30 days past each side of the strict LY window
// to cover SOs that cancel right at the edges of the operator's TY range.
const LY_DAILY_PADDING_DAYS = 30;

function isoMinusDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function fetchSalesAggregates({ rows, needT3, needLY, customer, customStart, customEnd, storeFilter, filterCategory, filterSubCategory, filterStyle, filterGender, needByCustomer, needLyDailyByStyle, needT3ByStyle, needLastCustomerPriceBySku }: FetchSalesArgs): Promise<SalesFetchResult> {
  // Window resolution. Default: T3 = trailing 3 months from today;
  // LY = same window shifted back 12 months (== [today-15m, today-12m]).
  // Custom: T3 = [customStart, customEnd]; LY = the same range -12mo.
  const today = todayIso();
  const useCustom = !!(customStart && customEnd);
  const t3Start = useCustom ? customStart! : isoMinusMonths(today, 3);
  const t3End   = useCustom ? customEnd!   : today;
  const lyStart = isoMinusMonths(t3Start, 12);
  const lyEnd   = isoMinusMonths(t3End,   12);
  const windows: SalesFetchWindows = { t3Start, t3End, lyStart, lyEnd };
  // Widened LY range — only used to bucket per-style daily aggs for the
  // per-SO window math. The summary `ly` aggregate still uses the strict
  // [lyStart, lyEnd] gate so existing non-SO views are unaffected.
  const lyDailyStart = needLyDailyByStyle ? isoMinusDays(lyStart, LY_DAILY_PADDING_DAYS) : lyStart;
  const lyDailyEnd   = needLyDailyByStyle ? isoPlusDays(lyEnd,    LY_DAILY_PADDING_DAYS) : lyEnd;
  // 12-month customer-last-price window. Fixed at [today-12mo, today]
  // regardless of any custom T3 range; the Mrgn % column wants the
  // customer's most recent buy across the past year, not the operator's
  // selected analysis window.
  const custLastStart = isoMinusMonths(today, 12);
  const custLastEnd   = today;

  if (!needT3 && !needLY && !needT3ByStyle && !needLastCustomerPriceBySku) return { windows, t3: new Map(), ly: new Map(), extraBySkuId: new Map() };
  if (!SB_URL) {
    console.warn("[ATS export] Supabase not configured — T3/LY columns will be empty.");
    return { windows, t3: new Map(), ly: new Map(), extraBySkuId: new Map() };
  }

  // The fetch + resolve work happens after the operator clicks Export,
  // so we await the master cache here in case it hasn't loaded yet
  // (ATS bootstraps it on app start but a freshly-opened tab might
  // still be loading).
  if (!isItemMasterLoaded()) {
    try { await loadItemMasterCache(); } catch (e) {
      console.error("[ATS export] item-master cache load failed:", e);
    }
  }

  // Pick the outer fetch window. We pull the union of both per-block
  // windows from the DB / cache, then bucket per-row in the loop below.
  // When needLyDailyByStyle is set, use the padded LY range so each
  // per-SO window (cancel_date - 12mo ± 30d) is fully covered even at
  // the edges of the operator's TY window.
  const effectiveLyStart = needLyDailyByStyle ? lyDailyStart : lyStart;
  const effectiveLyEnd   = needLyDailyByStyle ? lyDailyEnd   : lyEnd;
  // Union the active windows: T3 / T3ByStyle (T3 window), LY, customer-
  // last-price (12mo). At least one need is guaranteed by the early-
  // return above.
  const wantT3Window  = needT3 || needT3ByStyle;
  const candidates: Array<{ s: string; e: string }> = [];
  if (wantT3Window)              candidates.push({ s: t3Start,       e: t3End });
  if (needLY)                    candidates.push({ s: effectiveLyStart, e: effectiveLyEnd });
  if (needLastCustomerPriceBySku) candidates.push({ s: custLastStart, e: custLastEnd });
  let fetchStart = candidates[0].s;
  let fetchEnd   = candidates[0].e;
  for (const c of candidates) {
    if (c.s < fetchStart) fetchStart = c.s;
    if (c.e > fetchEnd)   fetchEnd   = c.e;
  }

  // Resolve customer name(s) → union of matching ip_customer_master.ids
  // across every provided name. Empty input = "all customers"; non-empty
  // input that resolves to zero ids means "no rows", not "all customers".
  const customerNames = Array.isArray(customer)
    ? customer.map((s) => s.trim()).filter(Boolean)
    : (customer.trim() ? [customer.trim()] : []);
  let customerIdSet: Set<string> | null = null;
  if (customerNames.length > 0) {
    const idLists = await Promise.all(customerNames.map((n) => resolveCustomerIds(n)));
    const merged = new Set<string>();
    idLists.forEach((ids, i) => {
      if (ids.length === 0) {
        console.warn(`[ATS export] customer "${customerNames[i]}" not in ip_customer_master — its rows will be empty.`);
      }
      for (const id of ids) merged.add(id);
    });
    if (merged.size === 0) {
      console.warn(`[ATS export] none of ${customerNames.length} customer name(s) matched ip_customer_master — T3/LY will be empty.`);
      return { windows, t3: new Map(), ly: new Map(), extraBySkuId: new Map() };
    }
    customerIdSet = merged;
    console.info(`[ATS export] customer filter resolved ${customerNames.length} name(s) → ${merged.size} ip_customer_master row(s).`);
  }

  const { idToSku, matched, unmatched } = buildIdToSkuMap(rows);
  console.info(`[ATS export] master-id mapping: ${matched} matched, ${unmatched} unmatched, ${idToSku.size} variant ids`);
  if (idToSku.size === 0) {
    console.warn("[ATS export] no ATS rows resolved to ip_item_master — T3/LY will be empty. Master cache loaded:", isItemMasterLoaded());
    return { windows, t3: new Map(), ly: new Map(), extraBySkuId: new Map() };
  }

  // Cache-first path: when the preloaded 15-month window covers the
  // requested range, slice in-memory instead of round-tripping. The
  // preload is kicked off at app start (ATS.tsx) so this is usually
  // warm by the time the operator clicks Export.
  //
  // When the cache doesn't cover (e.g. custom date range reaches
  // earlier than the 15-month preload window — operator picks Jan of
  // last year while today is in May, so LY block needs Jan-Feb of two
  // years ago), always directFetch the requested range. Previously
  // the fallback awaited the in-flight preload Promise even when the
  // preload covered a strictly smaller window — the export silently
  // missed every sale before the preload's start. Surfaced by a user
  // report: ROF LY total $4.83M vs DB truth $6.87M, exactly the
  // 2025-01-01..02-18 slice that fell off the preload edge.
  // Clamp the fetch upper bound to today. ip_sales_history_wholesale
  // is shipped-sales data — no rows have txn_date > today. For a
  // forward-looking window (e.g. 2026-05-22 → 2026-12-31 with LY
  // shift back to 2025-05-22), the raw fetchEnd would span 19
  // months; clamping cuts the worst case down to whatever portion
  // sits in the past. Saw a 32m44s top-burner query in Supabase
  // perf reports tracing to this; without the clamp every forward
  // window hammers the DB with LIMIT/OFFSET pagination across an
  // ever-deepening empty tail.
  const clampedFetchEnd = fetchEnd > today ? today : fetchEnd;
  // If clamping leaves an empty range (entire requested window is
  // in the future and there's no LY block), nothing to fetch.
  let salesRows: SalesRow[];
  if (clampedFetchEnd < fetchStart) {
    console.info(`[ATS export] fetch range entirely in the future (${fetchStart}..${fetchEnd}); skipping DB round trip`);
    salesRows = [];
  } else if (cacheCovers(fetchStart, clampedFetchEnd)) {
    salesRows = salesCacheRows!;
    console.info(`[ATS export] using cached sales (${salesRows.length} rows, window ${salesCacheStart}..${salesCacheEnd})`);
  } else {
    console.info(`[ATS export] cache window ${salesCacheStart ?? "—"}..${salesCacheEnd ?? "—"} does not cover ${fetchStart}..${clampedFetchEnd}; direct-fetching the requested range.`);
    salesRows = await directFetch(fetchStart, clampedFetchEnd);
  }

  // In-memory customer filter (the sales-row cache is unfiltered so
  // it can serve every customer's view). Match on any id in the
  // resolved set — a single dropdown name can correspond to multiple
  // ip_customer_master rows (Xoro variant spellings).
  if (customerIdSet) {
    const before = salesRows.length;
    salesRows = salesRows.filter(r => r.customer_id != null && customerIdSet!.has(r.customer_id));
    console.info(`[ATS export] customer filter: ${salesRows.length}/${before} sales rows match`);
  }

  // In-memory store filter. Resolves store codes ("ROF", "ROF ECOM",
  // "PT") to channel_ids on the fly. Rows with NULL channel_id
  // (historical, pre-migration-20260518030000) are excluded from any
  // specific-store filter — operator re-runs the nightly invoice sync
  // to backfill those.
  const wantStoreFilter = Array.isArray(storeFilter) && storeFilter.length > 0
    && !storeFilter.includes("All");
  if (wantStoreFilter) {
    try {
      const channelIds = await resolveChannelIds(storeFilter as string[]);
      if (channelIds.size === 0) {
        console.warn(`[ATS export] store filter "${storeFilter!.join(",")}" matched no channels — T3/LY will be empty.`);
        return { windows, t3: new Map(), ly: new Map(), extraBySkuId: new Map() };
      }
      const before = salesRows.length;
      salesRows = salesRows.filter(r => r.channel_id != null && channelIds.has(r.channel_id));
      console.info(`[ATS export] store filter (${storeFilter!.join(",")}): ${salesRows.length}/${before} sales rows match`);
    } catch (e) {
      console.error(`[ATS export] store filter failed:`, e);
      // Continue without store filter rather than break the export.
    }
  }

  const t3: SalesAggMap = new Map();
  const ly: SalesAggMap = new Map();
  // Master-derived SKU filter. When the operator has any cat/sub-cat/
  // style filter active, totals must include sales from SKUs that match
  // those filters even when those SKUs aren't currently in the grid
  // (their only PO/inventory row was tagged a store the operator
  // filtered out). Without this, cross-store math doesn't reconcile
  // (e.g. ROF + PT shows $4M when channel totals say $6.8M).
  //
  // null = no filter (keep existing grid-only behaviour for back-compat).
  const hasFilterableNonStoreSelection =
    (filterCategory    && filterCategory.length    > 0) ||
    (filterSubCategory && filterSubCategory.length > 0) ||
    (filterStyle       && filterStyle.length       > 0) ||
    (filterGender      && filterGender.length      > 0);
  let validSkuIds: Set<string> | null = null;
  if (hasFilterableNonStoreSelection || wantStoreFilter) {
    validSkuIds = getMatchingItemMasterIds({
      filterCategory:    filterCategory    ?? [],
      filterSubCategory: filterSubCategory ?? [],
      filterStyle:       filterStyle       ?? [],
      filterGender:      filterGender      ?? [],
    });
  }
  // Cross-grid: sku_ids that have sales but aren't in the current grid.
  // The export-render layer surfaces these as synthetic rows so totals
  // include every sale that matches the operator's filter scope, not
  // just sales for SKUs that happen to have a current inventory / PO /
  // SO row. Bug history:
  //   - Originally activated only by a customer filter (PRs #84-89).
  //   - PR #224 extended to store / cat / sub-cat / style filters to
  //     close the $2.8M cross-channel gap when narrowing by store.
  //   - This change extends it UNCONDITIONALLY — even with "All stores"
  //     and no other filter, "Total" math must include every sale
  //     in the trailing window, not just those tied to a current grid
  //     row. Otherwise SKUs that sold but went out-of-stock (no current
  //     PO/SO/inventory row) silently drop from the total — that's the
  //     ~$700K "selecting all stores doesn't compute" gap operators saw.
  const extraBySkuId: SalesFetchResult["extraBySkuId"] = new Map();
  // Only collect cross-grid extras when at least one of the T3 / LY
  // columns is actually being displayed. A Mrgn-%-only fetch otherwise
  // bubbles unmapped sku_ids in here and triggers synthetic-row injection
  // downstream with nothing to populate.
  const shouldCollectExtras = needT3 || needLY;

  // Per-customer accumulator. Populated alongside the per-sku maps so
  // the byCustomer rollup uses the same filtered row set + the same
  // T3/LY windows — no second pass, no extra fetch.
  //
  // bySku carries the per-(customer, sku_id) breakdown used by the
  // customer dim's grain-aware aggregator. Built in the same row scan
  // (no extra DB query) — every (cust, sku) pair seen in the filtered
  // row set gets its own t3/ly slot.
  type CustSkuAcc = { t3: SalesAggregate; ly: SalesAggregate };
  type CustAcc = { t3: SalesAggregate; ly: SalesAggregate; bySku: Map<string, CustSkuAcc> };
  const byCustomerAcc: Map<string, CustAcc> = new Map();
  const ensureCust = (custId: string): CustAcc => {
    const cur = byCustomerAcc.get(custId);
    if (cur) return cur;
    const fresh: CustAcc = {
      t3: { qty: 0, totalPrice: 0, marginAmount: 0 },
      ly: { qty: 0, totalPrice: 0, marginAmount: 0 },
      bySku: new Map(),
    };
    byCustomerAcc.set(custId, fresh);
    return fresh;
  };
  const ensureCustSku = (cust: CustAcc, skuId: string): CustSkuAcc => {
    const cur = cust.bySku.get(skuId);
    if (cur) return cur;
    const fresh: CustSkuAcc = {
      t3: { qty: 0, totalPrice: 0, marginAmount: 0 },
      ly: { qty: 0, totalPrice: 0, marginAmount: 0 },
    };
    cust.bySku.set(skuId, fresh);
    return fresh;
  };

  // Per-style daily LY accumulator. Only populated when the caller asked
  // for it (needLyDailyByStyle). Inner map keyed by ISO date so multiple
  // sales of the same style on the same day collapse into one entry —
  // we flatten + sort into an array after the loop.
  const lyDailyAcc: Map<string, Map<string, DailyStyleAgg>> | null = needLyDailyByStyle ? new Map() : null;
  // T3-by-style accumulator for the Mrgn % column. Keyed by master
  // style_code so every variant of the same style sees the same
  // weighted avg sell price.
  const t3ByStyleAcc: Map<string, SalesAggregate> | null = needT3ByStyle ? new Map() : null;
  // Per-ATS-sku most-recent unit_price in the last 12 months. Tracks
  // the latest (date, unit_price) pair seen — when txn_date ties, the
  // last row read in date-ascending order wins (the table is paged
  // ascending so this naturally ends up = latest invoice of the day).
  const lastCustPriceAcc: Map<string, { price: number; date: string }> | null = needLastCustomerPriceBySku ? new Map() : null;

  for (const r of salesRows) {
    const inT3 = needT3 && r.txn_date >= t3Start && r.txn_date <= t3End;
    const inLY = needLY && r.txn_date >= lyStart && r.txn_date <= lyEnd;
    // Widened LY gate for the per-style daily map. Catches sales that
    // fall outside the strict LY window but inside the ±30d padding
    // used by per-SO LY windows.
    const inLyDaily = lyDailyAcc != null && r.txn_date >= lyDailyStart && r.txn_date <= lyDailyEnd;
    // T3 window for the style-level aggregator. Independent of `inT3`
    // — kicks in for needT3ByStyle even when the operator didn't ask
    // for the T3 columns themselves.
    const inT3Style = t3ByStyleAcc != null && r.txn_date >= t3Start && r.txn_date <= t3End;
    const inCustLast = lastCustPriceAcc != null && r.txn_date >= custLastStart && r.txn_date <= custLastEnd;
    if (!inT3 && !inLY && !inLyDaily && !inT3Style && !inCustLast) continue;

    // qty_units is the authoritative unit-grain qty written by the
    // nightly sync handler (since migration 20260517230000). Falls
    // back to qty for legacy rows + rows from non-nightly write paths
    // (xoro-sales-sync, browser excel modal) until those are updated.
    // The fallback is correct for non-prepack rows (qty_units == qty)
    // but produces explosion-shaped results for legacy prepack rows
    // until the nightly re-runs them — that's the expected migration
    // posture, not a regression.
    const qty = r.qty_units != null ? toNum(r.qty_units) : toNum(r.qty);
    let rev = toNum(r.net_amount);
    if (rev <= 0) rev = toNum(r.unit_price) * toNum(r.qty);
    // margin_amount is NULL for legacy / non-nightly rows — we treat
    // missing as 0 so the per-SKU sum doesn't get polluted with NaN,
    // but the downstream margin% display suppresses the column when
    // the aggregate's marginAmount is 0 (no signal vs. 0% margin).
    const marg = toNum(r.margin_amount);

    // When a non-store filter is active, master-derived validSkuIds
    // narrows what's eligible. Sales for SKUs outside that set are
    // dropped entirely (correct — they don't match the filter).
    if (validSkuIds && !validSkuIds.has(r.sku_id)) continue;

    // Per-customer rollup. Same qty / rev / margin numbers we just
    // computed above, bucketed under the row's customer_id (or
    // "__unknown" when the row has no customer linkage). bySku also
    // gets the per-(customer, sku_id) split so the customer-dim
    // aggregator can classify grain per sku and split/collapse rows.
    if (needByCustomer) {
      const acc = ensureCust(r.customer_id ?? "__unknown");
      if (inT3) { acc.t3.qty += qty; acc.t3.totalPrice += rev; acc.t3.marginAmount += marg; }
      if (inLY) { acc.ly.qty += qty; acc.ly.totalPrice += rev; acc.ly.marginAmount += marg; }
      const cs = ensureCustSku(acc, r.sku_id);
      if (inT3) { cs.t3.qty += qty; cs.t3.totalPrice += rev; cs.t3.marginAmount += marg; }
      if (inLY) { cs.ly.qty += qty; cs.ly.totalPrice += rev; cs.ly.marginAmount += marg; }
    }

    const atsSku = idToSku.get(r.sku_id);
    if (atsSku) {
      if (inT3) {
        const ex = t3.get(atsSku);
        if (ex) { ex.qty += qty; ex.totalPrice += rev; ex.marginAmount += marg; }
        else t3.set(atsSku, { qty, totalPrice: rev, marginAmount: marg });
      }
      if (inLY) {
        const ex = ly.get(atsSku);
        if (ex) { ex.qty += qty; ex.totalPrice += rev; ex.marginAmount += marg; }
        else ly.set(atsSku, { qty, totalPrice: rev, marginAmount: marg });
      }
    } else if (shouldCollectExtras) {
      let ex = extraBySkuId.get(r.sku_id);
      if (!ex) {
        ex = {
          qty: 0, totalPrice: 0, marginAmount: 0,
          t3Qty: 0, t3Total: 0, t3Margin: 0,
          lyQty: 0, lyTotal: 0, lyMargin: 0,
        };
        extraBySkuId.set(r.sku_id, ex);
      }
      if (inT3) { ex.t3Qty += qty; ex.t3Total += rev; ex.t3Margin += marg; }
      if (inLY) { ex.lyQty += qty; ex.lyTotal += rev; ex.lyMargin += marg; }
      ex.qty += qty;
      ex.totalPrice += rev;
      ex.marginAmount += marg;
    }

    // Per-(style, date) LY accumulator. Sized to the widened lyDaily
    // window so the SO view's per-row ±30d lookup is always covered.
    // Resolved through the in-memory master cache — `r.sku_id` is the
    // ip_item_master uuid, and getItemMasterById is O(1).
    if (lyDailyAcc && inLyDaily) {
      const master = getItemMasterById(r.sku_id);
      const style = master?.style_code;
      if (style) {
        let perDate = lyDailyAcc.get(style);
        if (!perDate) { perDate = new Map(); lyDailyAcc.set(style, perDate); }
        let agg = perDate.get(r.txn_date);
        if (!agg) {
          agg = { date: r.txn_date, qty: 0, totalPrice: 0, marginAmount: 0 };
          perDate.set(r.txn_date, agg);
        }
        agg.qty += qty;
        agg.totalPrice += rev;
        agg.marginAmount += marg;
      }
    }

    // T3 sales rolled up to style. Independent of inT3 (the per-variant
    // map) — fires whenever the T3 window includes the row AND the
    // caller asked for the style rollup.
    if (t3ByStyleAcc && inT3Style) {
      const master = getItemMasterById(r.sku_id);
      const style = master?.style_code;
      if (style) {
        const ex = t3ByStyleAcc.get(style);
        if (ex) { ex.qty += qty; ex.totalPrice += rev; ex.marginAmount += marg; }
        else t3ByStyleAcc.set(style, { qty, totalPrice: rev, marginAmount: marg });
      }
    }

    // Customer last-known price. Tracks the most recent (txn_date,
    // unit_price) per ATS-sku. Only meaningful when the caller passed
    // a customer filter upstream (otherwise this aggregates everyone's
    // most-recent buy across the whole table — not the intent).
    if (lastCustPriceAcc && inCustLast) {
      const atsSkuForCust = idToSku.get(r.sku_id);
      if (atsSkuForCust) {
        const unit = toNum(r.unit_price);
        const price = unit > 0 ? unit : (qty > 0 ? rev / qty : 0);
        if (price > 0) {
          const prev = lastCustPriceAcc.get(atsSkuForCust);
          if (!prev || r.txn_date >= prev.date) {
            lastCustPriceAcc.set(atsSkuForCust, { price, date: r.txn_date });
          }
        }
      }
    }
  }

  // Flatten the per-style daily LY accumulator into the result shape.
  // Each style's array is sorted by date ascending so callers can scan
  // a window in O(n) without re-sorting.
  let lyDailyByStyle: Map<string, DailyStyleAgg[]> | undefined;
  if (lyDailyAcc) {
    lyDailyByStyle = new Map();
    for (const [style, perDate] of lyDailyAcc) {
      const arr = [...perDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      lyDailyByStyle.set(style, arr);
    }
    console.info(`[ATS export] lyDailyByStyle → ${lyDailyByStyle.size} styles, window ${lyDailyStart}..${lyDailyEnd}`);
  }

  console.info(`[ATS export] aggregated → t3:${t3.size} SKUs, ly:${ly.size} SKUs, extras:${extraBySkuId.size} (customer=${customerNames.length === 0 ? "all" : customerNames.join("+")}, windows t3=${t3Start}..${t3End} ly=${lyStart}..${lyEnd})`);

  // Resolve customer_id → name in one batch, then build the public
  // byCustomer Map. Done after the row scan so we only query for the
  // customer_ids that actually have sales in window.
  let byCustomer: CustomerRollup | undefined;
  if (needByCustomer && byCustomerAcc.size > 0) {
    byCustomer = new Map();
    const realIds = [...byCustomerAcc.keys()].filter(id => id !== "__unknown");
    const nameById = new Map<string, string>();
    if (realIds.length > 0) {
      try {
        // PostgREST `in.(...)` with quoted uuids. Chunked to keep the
        // URL under typical 8k limits; 200 ids per request is well
        // within that ceiling.
        const CHUNK = 200;
        for (let i = 0; i < realIds.length; i += CHUNK) {
          const chunk = realIds.slice(i, i + CHUNK);
          const enc = chunk.map(id => `"${id}"`).join(",");
          const rows = await sbGet<{ id: string; name: string }>(
            `ip_customer_master?select=id,name&id=in.(${encodeURIComponent(enc)})&limit=${chunk.length}`,
          );
          for (const r of rows) if (r.id && r.name) nameById.set(r.id, r.name);
        }
      } catch (e) {
        console.warn("[ATS export] byCustomer name resolution failed:", e);
      }
    }
    for (const [custId, acc] of byCustomerAcc) {
      byCustomer.set(custId, {
        customerName: custId === "__unknown" ? "(unknown / no customer)" : (nameById.get(custId) ?? custId.slice(0, 8)),
        t3: acc.t3,
        ly: acc.ly,
        bySku: acc.bySku,
      });
    }
    console.info(`[ATS export] byCustomer rollup → ${byCustomer.size} customers (${realIds.length - nameById.size} unresolved name${realIds.length - nameById.size === 1 ? "" : "s"})`);
  }

  const t3ByStyle = t3ByStyleAcc ?? undefined;
  const lastCustomerPriceBySku = lastCustPriceAcc ?? undefined;
  if (t3ByStyle) {
    console.info(`[ATS export] t3ByStyle → ${t3ByStyle.size} styles, window ${t3Start}..${t3End}`);
  }
  if (lastCustomerPriceBySku) {
    console.info(`[ATS export] lastCustomerPriceBySku → ${lastCustomerPriceBySku.size} SKUs, window ${custLastStart}..${custLastEnd}`);
  }
  return { windows, t3, ly, extraBySkuId, byCustomer, lyDailyByStyle, t3ByStyle, lastCustomerPriceBySku };
}

// Resolve sales aggregates for one ATS-row SKU, narrowed by customer
// if provided. Used by the grid's right-click SO menu so the operator
// can see T3 / SP-LY in context. Awaits the preload cache; resolves
// customer + master-id lookups from in-memory state.
//
// Returns null when something fundamental is missing (no Supabase, no
// item-master cache, customer name doesn't resolve, etc.) — caller
// shows a friendly "no data" cell.
export interface SkuSalesAggregates {
  t3: SalesAggregate;
  ly: SalesAggregate;
  t3Window: { start: string; end: string };
  lyWindow: { start: string; end: string };
}

export async function getSkuSalesAggregates(sku: string, customer: string): Promise<SkuSalesAggregates | null> {
  if (!SB_URL) return null;
  if (!isItemMasterLoaded()) {
    try { await loadItemMasterCache(); } catch { return null; }
  }

  const spaceDelim = sku.indexOf(" - ");
  const stylePart = spaceDelim !== -1 ? sku.slice(0, spaceDelim).trim() : sku.trim();
  const ids = resolveItemMasterIds(sku, stylePart || null);
  if (ids.length === 0) return null;
  const idSet = new Set(ids);

  let customerIdSet: Set<string> | null = null;
  if (customer) {
    const ids = await resolveCustomerIds(customer);
    if (ids.length === 0) {
      // Customer doesn't match the master — empty aggregates rather
      // than fall back to all-customer data (would be misleading
      // given the operator explicitly selected one).
      const today = todayIso();
      return {
        t3: { qty: 0, totalPrice: 0, marginAmount: 0 },
        ly: { qty: 0, totalPrice: 0, marginAmount: 0 },
        t3Window: { start: isoMinusMonths(today, 3), end: today },
        lyWindow: { start: isoMinusMonths(today, 15), end: isoMinusMonths(today, 12) },
      };
    }
    customerIdSet = new Set(ids);
  }

  // Use the cache if warm; otherwise await the preload Promise; if
  // neither is available, fetch directly for the wide window.
  let salesRows: SalesRow[];
  const today = todayIso();
  const t3Start = isoMinusMonths(today, 3);
  const lyEnd   = isoMinusMonths(today, 12);
  const lyStart = isoMinusMonths(today, 15);
  if (cacheCovers(lyStart, today)) {
    salesRows = salesCacheRows!;
  } else if (salesCachePromise) {
    try { salesRows = await salesCachePromise; } catch { salesRows = await directFetch(lyStart, today); }
  } else {
    salesRows = await directFetch(lyStart, today);
  }

  // qty_units (when populated by the nightly handler) is at unit grain.
  // Fall back to qty for legacy / non-nightly rows. Margin sums roll up
  // alongside qty + revenue so callers can compute aggregate margin %.
  let t3Qty = 0, t3Total = 0, t3Margin = 0;
  let lyQty = 0, lyTotal = 0, lyMargin = 0;
  for (const r of salesRows) {
    if (!idSet.has(r.sku_id)) continue;
    if (customerIdSet && (r.customer_id == null || !customerIdSet.has(r.customer_id))) continue;
    const qty = r.qty_units != null ? toNum(r.qty_units) : toNum(r.qty);
    let rev = toNum(r.net_amount);
    if (rev <= 0) rev = toNum(r.unit_price) * toNum(r.qty);
    const marg = toNum(r.margin_amount);
    if (r.txn_date >= t3Start && r.txn_date <= today) {
      t3Qty += qty;
      t3Total += rev;
      t3Margin += marg;
    }
    if (r.txn_date >= lyStart && r.txn_date <= lyEnd) {
      lyQty += qty;
      lyTotal += rev;
      lyMargin += marg;
    }
  }

  return {
    t3: { qty: t3Qty, totalPrice: t3Total, marginAmount: t3Margin },
    ly: { qty: lyQty, totalPrice: lyTotal, marginAmount: lyMargin },
    t3Window: { start: t3Start, end: today },
    lyWindow: { start: lyStart, end: lyEnd },
  };
}

// Direct (un-cached) fetch for the requested window. Used on cache
// miss when the preload hasn't run.
async function directFetch(start: string, end: string): Promise<SalesRow[]> {
  // The SELECT list MUST match the SalesRow type. Missing channel_id /
  // qty_units / margin_amount is a silent killer: downstream the
  // store filter compares against `r.channel_id`, and
  // `channelIds.has(undefined)` is false — so every row gets dropped
  // when the requested window extends past the cache (e.g. picking a
  // future TY window for an open-SO comp). Symptom from prod
  // 2026-05-21: Ross + 5/21–7/31 2026 TY window returned 0 SKUs even
  // though the LY shift had 384 rows / $3.87M in the DB.
  // Mirror every column the aggregator reads.
  const path = `ip_sales_history_wholesale?select=sku_id,customer_id,channel_id,txn_date,qty,qty_units,net_amount,unit_price,margin_amount&txn_date=gte.${start}&txn_date=lte.${end}&order=txn_date.asc`;
  // Page size 5000 vs the old 500: cuts page count 10x, which in
  // turn cuts the deepest OFFSET (the part Postgres pays for) 10x.
  // Each row is ~150 bytes so 5000 rows ≈ 750KB / page — well
  // under any transport limit. Aligns with the preload slice path
  // which already uses 1000+.
  const rows = await sbGetAll<SalesRow>(path, 5000);
  console.info(`[ATS export] direct fetch ${rows.length} sales rows for window ${start}..${end}`);
  return rows;
}
