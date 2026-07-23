// api/_lib/salesEnrichGuard.js
//
// Guard: the Excel/CSV sales ingest must never re-insert a colour-grain
// aggregate row for an invoice whose sales history has been SIZE-ENRICHED.
//
// Background (2026-07-23 incident): the AR size-enrichment ops (#1898/#1902/
// #1909) DELETE an invoice's colour-grain ip_sales_history_wholesale rows
// (source_line_key `excel:inv:<invoice>:<sku>:<date>`) and replace them with
// per-size rows under DIFFERENT keys (`excel:size:` / `excel:reprice:` /
// `excel:fill:` / `excel:relink:`). The nightly sales sync replays the full
// invoice CSV and upserts on (source, source_line_key) — with the colour keys
// gone, nothing conflicted and it re-inserted 19,081 colour aggregates on top
// of the size rows: every enriched invoice's history DOUBLED (3.5M phantom
// units / $27.9M) until a same-day supervised repair deleted them.
//
// The guard: before writing, look up which of the batch's invoice numbers
// already carry enriched rows, and drop those invoices' colour rows from the
// write set. Size-enriched history is strictly richer than the colour
// aggregate the CSV would recreate — skipping loses nothing.

/** source_line_key prefixes written by the size-enrichment ops. */
export const ENRICHED_PREFIXES = ["excel:size:", "excel:reprice:", "excel:fill:", "excel:relink:"];

/** PostgREST .or() filter matching any enriched source_line_key.
 *  `*` is PostgREST's canonical LIKE wildcard in URL filter syntax. */
export function enrichedKeyOrFilter() {
  return ENRICHED_PREFIXES.map((p) => `source_line_key.like.${p}*`).join(",");
}

/** True when a source_line_key marks a size-enriched row. */
export function isEnrichedKey(key) {
  const k = String(key ?? "");
  return ENRICHED_PREFIXES.some((p) => k.startsWith(p));
}

/** Distinct non-empty invoice numbers across the batch rows. */
export function distinctInvoiceNumbers(rows) {
  const out = new Set();
  for (const r of rows ?? []) {
    const inv = (r?.invoice_number ?? "").toString().trim();
    if (inv) out.add(inv);
  }
  return Array.from(out);
}

/**
 * Split the write set: rows whose invoice is size-enriched are skipped.
 * Rows without an invoice number are always kept (ship rows etc. — the
 * enrichment ops only ever touch invoice-linked history).
 */
export function partitionEnriched(rows, enrichedInvoiceSet) {
  const kept = [];
  const skipped = [];
  for (const r of rows ?? []) {
    const inv = (r?.invoice_number ?? "").toString().trim();
    if (inv && enrichedInvoiceSet.has(inv)) skipped.push(r);
    else kept.push(r);
  }
  return { kept, skipped };
}

/**
 * Fetch the subset of `invoiceNumbers` that already carry size-enriched
 * sales-history rows. `admin` is a supabase-js client. Chunked to keep the
 * in-list within URL limits. Fail-OPEN by design: a lookup error records the
 * message and returns what was found so far — blocking the whole nightly on
 * a transient read error would be worse than one re-repairable overlap, and
 * the caller surfaces `errors` for the operator either way.
 */
export async function fetchEnrichedInvoiceSet(admin, invoiceNumbers, { chunkSize = 200, errors = [] } = {}) {
  const found = new Set();
  const orFilter = enrichedKeyOrFilter();
  for (let i = 0; i < invoiceNumbers.length; i += chunkSize) {
    const chunk = invoiceNumbers.slice(i, i + chunkSize);
    const { data, error } = await admin
      .from("ip_sales_history_wholesale")
      .select("invoice_number")
      .in("invoice_number", chunk)
      .or(orFilter);
    if (error) {
      errors.push(`enriched-invoice lookup chunk ${i}: ${error.message}`);
      continue;
    }
    for (const row of data ?? []) {
      const inv = (row?.invoice_number ?? "").toString().trim();
      if (inv) found.add(inv);
    }
  }
  return found;
}
