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
import { isItemMasterLoaded, loadItemMasterCache, resolveItemMasterIds } from "./itemMasterLookup";

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

function toNum(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function resolveCustomerId(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const enc = encodeURIComponent(trimmed);
  const rows = await sbGet<{ id: string }>(
    `ip_customer_master?select=id&name=eq.${enc}&limit=1`,
  );
  return rows[0]?.id ?? null;
}

// Build the variant-id → ATS-sku reverse map. Walks each ATS row,
// resolves it to one or more ip_item_master.id values via the existing
// item-master cache (which already handles canonicalization, PPK
// suffix aliasing, style-level fallback). Multiple ids may map to the
// same ATS sku when the row is at style grain.
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

function aggregate(salesRows: SalesRow[], idToSku: Map<string, string>): SalesAggMap {
  const out: SalesAggMap = new Map();
  for (const r of salesRows) {
    const atsSku = idToSku.get(r.sku_id);
    if (!atsSku) continue;
    const qty = toNum(r.qty);
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
  needT3: boolean;
  needLY: boolean;
  customer: string;
}

export async function fetchSalesAggregates({ rows, needT3, needLY, customer }: FetchSalesArgs): Promise<SalesFetchResult> {
  if (!needT3 && !needLY) return { t3: new Map(), ly: new Map() };
  if (!SB_URL) {
    console.warn("[ATS export] Supabase not configured — T3/LY columns will be empty.");
    return { t3: new Map(), ly: new Map() };
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

  const today = todayIso();
  const t3Start = isoMinusMonths(today, 3);
  const lyEnd   = isoMinusMonths(today, 12);
  const lyStart = isoMinusMonths(today, 15);

  let fetchStart: string;
  let fetchEnd: string;
  if (needT3 && needLY) { fetchStart = lyStart; fetchEnd = today; }
  else if (needT3)      { fetchStart = t3Start; fetchEnd = today; }
  else                  { fetchStart = lyStart; fetchEnd = lyEnd; }

  let customerClause = "";
  if (customer) {
    const cid = await resolveCustomerId(customer);
    if (!cid) {
      console.warn(`[ATS export] customer "${customer}" not in ip_customer_master — T3/LY will be empty.`);
      return { t3: new Map(), ly: new Map() };
    }
    customerClause = `&customer_id=eq.${cid}`;
  }

  const { idToSku, matched, unmatched } = buildIdToSkuMap(rows);
  console.info(`[ATS export] master-id mapping: ${matched} matched, ${unmatched} unmatched, ${idToSku.size} variant ids`);
  if (idToSku.size === 0) {
    console.warn("[ATS export] no ATS rows resolved to ip_item_master — T3/LY will be empty. Master cache loaded:", isItemMasterLoaded());
    return { t3: new Map(), ly: new Map() };
  }

  const path = `ip_sales_history_wholesale?select=sku_id,customer_id,txn_date,qty,net_amount,unit_price&txn_date=gte.${fetchStart}&txn_date=lte.${fetchEnd}${customerClause}&order=txn_date.asc`;
  const salesRows = await sbGetAll<SalesRow>(path, 500);
  console.info(`[ATS export] fetched ${salesRows.length} sales rows for window ${fetchStart}..${fetchEnd}${customer ? ` (customer=${customer})` : ""}`);

  const t3Rows: SalesRow[] = [];
  const lyRows: SalesRow[] = [];
  for (const r of salesRows) {
    if (needT3 && r.txn_date >= t3Start && r.txn_date <= today)  t3Rows.push(r);
    if (needLY && r.txn_date >= lyStart && r.txn_date <= lyEnd)  lyRows.push(r);
  }

  const t3 = needT3 ? aggregate(t3Rows, idToSku) : new Map();
  const ly = needLY ? aggregate(lyRows, idToSku) : new Map();
  console.info(`[ATS export] aggregated → t3:${t3.size} SKUs, ly:${ly.size} SKUs`);
  return { t3, ly };
}
