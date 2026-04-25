export interface XoroSalesIngestResult {
  xoro_lines_fetched: number;
  inserted: number;
  skipped_no_sku: number;
  skipped_no_date: number;
  skipped_zero_qty: number;
  errors: string[];
  path: string;
  date_from: string;
  date_to: string;
  error?: string;
  debug?: unknown;
}

export async function ingestXoroSales(opts: {
  dateFrom: string;
  dateTo: string;
  path?: string;
}): Promise<XoroSalesIngestResult> {
  const p = new URLSearchParams({
    date_from: opts.dateFrom,
    date_to: opts.dateTo,
  });
  if (opts.path) p.set("path", opts.path);
  const r = await fetch(`/api/xoro-sales-sync?${p.toString()}`);
  if (!r.ok) throw new Error(`Sales ingest API returned ${r.status}`);
  return r.json();
}
