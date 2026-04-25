export interface XoroSalesIngestResult {
  xoro_lines_fetched: number;
  inserted: number;
  skipped_no_sku: number;
  skipped_no_date: number;
  skipped_zero_qty: number;
  skipped_ecom_store?: number;
  skipped_outside_window?: number;
  oldest_invoice_in_batch?: string | null;
  newest_invoice_in_batch?: string | null;
  before_window?: boolean;
  past_window?: boolean;
  auto_created_skus?: number;
  auto_created_customers?: number;
  errors: string[];
  path: string;
  date_from: string;
  date_to: string;
  page_start?: number;
  page_limit?: number;
  error?: string;
  debug?: unknown;
}

export async function ingestXoroSales(opts: {
  dateFrom: string;
  dateTo: string;
  path?: string;
  pageStart?: number;
}): Promise<XoroSalesIngestResult> {
  const p = new URLSearchParams({
    date_from: opts.dateFrom,
    date_to: opts.dateTo,
  });
  if (opts.path) p.set("path", opts.path);
  if (opts.pageStart != null) p.set("page_start", String(opts.pageStart));
  const r = await fetch(`/api/xoro-sales-sync?${p.toString()}`);
  if (!r.ok) throw new Error(`Sales ingest API returned ${r.status}`);
  return r.json();
}

export interface XoroItemsIngestResult {
  xoro_items_fetched: number;
  inserted: number;
  skipped_no_sku: number;
  skipped_inactive: number;
  errors: string[];
  path: string;
  error?: string;
  debug?: unknown;
  diagnostic?: unknown;
}

export async function ingestXoroItems(opts: { pageStart?: number; pageLimit?: number } = {}): Promise<XoroItemsIngestResult> {
  const p = new URLSearchParams();
  if (opts.pageStart != null) p.set("page_start", String(opts.pageStart));
  if (opts.pageLimit != null) p.set("page_limit", String(opts.pageLimit));
  const r = await fetch(`/api/xoro-items-sync${p.toString() ? "?" + p.toString() : ""}`);
  if (!r.ok) throw new Error(`Items ingest API returned ${r.status}`);
  return r.json();
}

export async function syncAtsSupply(opts: { start?: number; limit?: number } = {}): Promise<Record<string, unknown>> {
  const p = new URLSearchParams();
  if (opts.start != null) p.set("start", String(opts.start));
  if (opts.limit != null) p.set("limit", String(opts.limit));
  const r = await fetch(`/api/ats-supply-sync${p.toString() ? "?" + p.toString() : ""}`);
  if (!r.ok) throw new Error(`ATS supply sync returned ${r.status}`);
  return r.json();
}

export async function syncTandaPos(): Promise<Record<string, unknown>> {
  const r = await fetch(`/api/tanda-pos-sync`);
  if (!r.ok) throw new Error(`TandA POs sync returned ${r.status}`);
  return r.json();
}
