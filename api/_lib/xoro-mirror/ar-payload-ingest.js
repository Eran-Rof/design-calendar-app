// api/_lib/xoro-mirror/ar-payload-ingest.js
//
// Widen the size-grain AR feed (#1821) by ARCHIVING raw Xoro invoice/getinvoice
// payloads into raw_xoro_payloads(endpoint='sales-history') — the exact source
// ar-sizegrain.js explodes into per-size AR invoice lines.
//
// ⚠️ REACHABLE UNIVERSE (verified #1824, re-confirming #1820): Xoro's
// `invoice/getinvoice` REST endpoint returns ONLY the OPEN-invoice universe. It
// IGNORES every filter param we tried (InvoiceNumber, StatusName, dates) and
// always paginates the same ~44 pages × ~100/page ≈ 4,400 OPEN invoices
// (StatusName='Open' on 100/100 page-1 and 98/98 last-page samples). Closed /
// paid invoices — the bulk of the 24.6k historical AR rows — are NOT fetchable
// via any REST endpoint we have access to (every alternate path 500s). So the
// only way an invoice's per-size payload can ever be archived is to capture it
// WHILE IT IS STILL OPEN. This module is that ongoing capture. Already-closed
// history is a permanent honest residual.
//
// MEASURED COST (#1824): each page fetch takes ~45s (Xoro returns ~400-field
// headers; effective per_page caps at 100), so a full 44-page walk is ~35 min —
// far past a serverless budget. Hence TWO modes:
//   • tailPages: N  — fetch page 1 (learns TotalPages, archives its records),
//     then walk only the LAST N pages. Xoro paginates oldest-first, so newly
//     opened invoices appear on the tail; a nightly tail sweep captures every
//     new invoice while it's still open. Fits a 300s function (1 probe + N≈4).
//   • pageStart/maxPages — forward chunk walk, for the one-time historical
//     sweep of the current open universe (run from a local script, resumable).
//
// IDEMPOTENT + RESUMABLE: we load the set of invoice numbers already archived
// and SKIP them — a re-run writes nothing. New open invoices are appended in
// modest batches (batchSize invoices per raw_xoro_payloads row, small enough to
// keep row count far under the PostgREST 1000-row cap that ar-sizegrain.js
// reads under), with a small delay between flushes so an already-stressed prod
// DB isn't hammered.
//
// ⚠️ SLIM RECORDS (07-16 outage lesson — the prod DB fell over THREE times
// during full-payload sweeps): a raw invoice/getinvoice record is ~400 header
// fields (~30-80KB); batches of 100 made multi-MB jsonb rows whose writes AND
// reads (known-set load, explosion feed) knocked over the already-stressed
// instance. We now archive a WHITELISTED slice — exactly the fields
// ar-sizegrain.js::normalizeInvoicePayloadLines reads, plus a few header
// diagnostics — ~50× smaller. The archived invoice numbers are ALSO stored at
// payload.invoice_numbers so the known-set load selects ONLY that key
// (PostgREST `payload->invoice_numbers`) — the multi-MB record array is never
// serialized to the client. (raw_xoro_payloads has NO params column —
// insertRawXoro's params arg only feeds the source_hash.)

import { insertRawXoro } from "../planning-raw.js";

// Header fields kept on each slim record. InvoiceNumber is the join key;
// the rest are cheap diagnostics (status/date/customer/total).
const HEADER_KEEP = [
  "InvoiceNumber", "InvoiceNo", "TxnDate", "ShipDate", "InvoiceDate",
  "StatusName", "CustomerName", "TotalAmount", "FullPaymentDate", "CurrencyCode",
];
// Line fields kept — the exact cascade normalizeInvoicePayloadLines reads
// (ItemNumber/Sku/ItemCode, Qty variants, amounts, discount, unit, line ids).
const LINE_KEEP = [
  "ItemNumber", "Sku", "ItemCode",
  "Qty", "QtyInvoiced", "QtyShipped",
  "TotalAmount", "LineAmount",
  "Discount", "DiscountAmount",
  "EffectiveUnitPrice", "UnitPrice",
  "Id", "SoLineId", "LineNumber",
  "Description",
];

function pick(obj, keys) {
  const out = {};
  if (!obj) return out;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return out;
}

/** Whitelist-slim one raw invoice/getinvoice record down to the fields the
 *  size-grain explosion feed reads. ~50× smaller than the raw record. */
export function slimInvoiceRecord(rec) {
  const header = rec?.invoiceHeader ?? rec ?? {};
  const arr = Array.isArray(rec?.invoiceItemLineArr) ? rec.invoiceItemLineArr
            : Array.isArray(rec?.InvoiceItemLineArr) ? rec.InvoiceItemLineArr : [];
  return {
    invoiceHeader: pick(header, HEADER_KEEP),
    invoiceItemLineArr: arr.map((il) => pick(il, LINE_KEEP)),
  };
}

/** Invoice number off a raw invoice/getinvoice record (invoiceHeader.InvoiceNumber). */
export function invoiceNumberOf(rec) {
  const h = rec?.invoiceHeader ?? rec ?? {};
  const n = (h.InvoiceNumber ?? h.InvoiceNo ?? "").toString().trim();
  return n || null;
}

/** Extract the set of invoice numbers already present in a set of
 *  raw_xoro_payloads rows (each row.payload.data[] is an array of invoices). */
export function invoiceNumbersFromPayloadRows(rows) {
  const set = new Set();
  for (const row of rows || []) {
    const recs = Array.isArray(row?.payload?.data) ? row.payload.data : [];
    for (const rec of recs) {
      const n = invoiceNumberOf(rec);
      if (n) set.add(n);
    }
  }
  return set;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Load the invoice numbers already archived under endpoint='sales-history'.
 *
 * FAST PATH: rows written by this module carry payload.invoice_numbers, and
 * the first pass selects ONLY that key (`payload->invoice_numbers`) — the
 * record array is never serialized to the client.
 * LEGACY FALLBACK: rows written before #1824 (full payloads, no number list)
 * are fetched ONE ROW AT A TIME with a small delay — each can be several MB
 * and bulk-reading them contributed to the 07-15/16 prod DB outages.
 */
export async function loadArchivedInvoiceNumbers(admin, { pageSize = 200, legacyDelayMs = 250 } = {}) {
  const known = new Set();
  const legacyIds = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from("raw_xoro_payloads")
      .select("id, invoice_numbers:payload->invoice_numbers")
      .eq("endpoint", "sales-history")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`loadArchivedInvoiceNumbers: ${error.message}`);
    const rows = data || [];
    for (const row of rows) {
      const nums = row?.invoice_numbers;
      if (Array.isArray(nums) && nums.length > 0) {
        for (const n of nums) if (n) known.add(String(n));
      } else {
        legacyIds.push(row.id);
      }
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  for (const id of legacyIds) {
    const { data, error } = await admin
      .from("raw_xoro_payloads")
      .select("payload")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`loadArchivedInvoiceNumbers (legacy row ${id}): ${error.message}`);
    for (const n of invoiceNumbersFromPayloadRows(data ? [data] : [])) known.add(n);
    if (legacyDelayMs > 0) await sleep(legacyDelayMs);
  }
  return known;
}

/**
 * Walk the open-invoice universe and archive not-yet-seen invoices.
 *
 * @param {object} deps
 * @param {(page:number)=>Promise<{ok:boolean, records:object[], totalPages:number|null, status:number}>} deps.fetchPage
 * @param {object} deps.admin                     supabase service-role client
 * @param {(admin:any,args:any)=>Promise<{id?:string,deduped?:boolean,error?:string}>} [deps.insertRaw]
 * @param {()=>Promise<Set<string>>} [deps.loadKnown]  defaults to loadArchivedInvoiceNumbers(admin)
 * @param {object} [opts]
 * @param {number} [opts.pageStart=1]      forward mode: first page to walk
 * @param {number} [opts.maxPages=60]      forward mode: page budget
 * @param {number} [opts.tailPages]        tail mode: walk page 1 + the LAST N pages
 * @param {number} [opts.batchSize=50]     invoices per archived raw_xoro_payloads row
 * @param {number} [opts.pageDelayMs=250]  gentle inter-page delay
 * @param {number} [opts.flushDelayMs=500] gentle inter-DB-write delay
 * @param {(msg:string)=>void} [opts.log]
 */
export async function sweepOpenInvoicePayloads(deps, opts = {}) {
  const { fetchPage, admin } = deps;
  const insertRaw = deps.insertRaw || insertRawXoro;
  const loadKnown = deps.loadKnown || (() => loadArchivedInvoiceNumbers(admin));
  const pageStart = Math.max(1, opts.pageStart || 1);
  const maxPages = Math.min(Math.max(1, opts.maxPages || 60), 500);
  const tailPages = opts.tailPages ? Math.min(Math.max(1, opts.tailPages), 500) : null;
  const batchSize = Math.max(1, opts.batchSize || 50);
  const pageDelayMs = opts.pageDelayMs == null ? 250 : opts.pageDelayMs;
  const flushDelayMs = opts.flushDelayMs == null ? 500 : opts.flushDelayMs;
  const log = opts.log || (() => {});

  const summary = {
    mode: tailPages ? "tail" : "forward",
    pages_walked: 0,
    invoices_seen: 0,
    invoices_new: 0,
    invoices_known_skipped: 0,
    rows_written: 0,
    rows_deduped: 0,
    total_pages: null,
    last_page: 0,
    stopped_reason: null,
    errors: [],
  };

  const known = (await loadKnown()) || new Set();
  log(`known archived invoices: ${known.size}`);

  let batch = [];
  const flush = async () => {
    if (batch.length === 0) return;
    // Whitelist-slim every record (see SLIM RECORDS above). The number list
    // rides INSIDE payload (payload.invoice_numbers) so the known-set load can
    // select just that key — raw_xoro_payloads has no params column.
    const recs = batch.map(slimInvoiceRecord);
    batch = [];
    const nums = recs.map(invoiceNumberOf).filter(Boolean);
    const res = await insertRaw(admin, {
      endpoint: "sales-history",
      params: { source: "ar-payload-ingest", slim: true, count: nums.length },
      payload: { data: recs, invoice_numbers: nums },
      recordCount: recs.length,
      ingestedBy: "cron/ar-payload-ingest",
    });
    if (res?.error) {
      summary.errors.push(res.error);
      return;
    }
    if (res?.deduped) summary.rows_deduped += 1;
    else summary.rows_written += 1;
    if (flushDelayMs > 0) await sleep(flushDelayMs);
  };

  // Fold one fetched page's records into the batch.
  const processRecords = async (records) => {
    for (const rec of records) {
      summary.invoices_seen += 1;
      const num = invoiceNumberOf(rec);
      if (!num) continue;
      if (known.has(num)) {
        summary.invoices_known_skipped += 1;
        continue;
      }
      known.add(num);
      summary.invoices_new += 1;
      batch.push(rec);
      if (batch.length >= batchSize) await flush();
    }
  };

  const fetchOne = async (page) => {
    let r;
    try {
      r = await fetchPage(page);
    } catch (e) {
      summary.errors.push(`page ${page}: ${e?.message || e}`);
      summary.stopped_reason = "fetch_threw";
      return null;
    }
    if (!r || r.ok === false) {
      summary.errors.push(`page ${page}: fetch not ok (status=${r?.status ?? "?"})`);
      summary.stopped_reason = "fetch_failed";
      return null;
    }
    if (r.totalPages != null) summary.total_pages = r.totalPages;
    summary.pages_walked += 1;
    summary.last_page = page;
    return Array.isArray(r.records) ? r.records : [];
  };

  // Build the page walk list.
  let pages;
  if (tailPages) {
    // Probe page 1 first — it carries the authoritative TotalPages AND its
    // records are real data (don't waste the ~45s fetch).
    const rec1 = await fetchOne(1);
    if (rec1 == null) { await flush(); return summary; }
    await processRecords(rec1);
    log(`page 1 (probe): seen=${summary.invoices_seen} new=${summary.invoices_new} totalPages=${summary.total_pages}`);
    const tp = summary.total_pages;
    if (!tp || tp <= 1) {
      summary.stopped_reason = "single_page";
      await flush();
      return summary;
    }
    const start = Math.max(2, tp - tailPages + 1);
    pages = [];
    for (let p = start; p <= tp; p++) pages.push(p);
  } else {
    pages = [];
    for (let i = 0; i < maxPages; i++) pages.push(pageStart + i);
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (pageDelayMs > 0 && (i > 0 || tailPages)) await sleep(pageDelayMs);
    const records = await fetchOne(page);
    if (records == null) break; // fetch failure — stopped_reason already set
    if (records.length === 0) {
      summary.stopped_reason = "empty_page";
      break;
    }
    await processRecords(records);
    log(`page ${page}: seen=${summary.invoices_seen} new=${summary.invoices_new} skipped=${summary.invoices_known_skipped}`);
    if (!tailPages && summary.total_pages != null && page >= summary.total_pages) {
      summary.stopped_reason = "reached_total_pages";
      break;
    }
  }
  await flush();
  if (!summary.stopped_reason) summary.stopped_reason = tailPages ? "tail_complete" : "max_pages";
  return summary;
}

/**
 * fetchPage adapter over the real Xoro client. Kept here so the cron + backfill
 * script share one definition. `fetchXoroAll` is injected to keep this testable.
 */
export function makeXoroInvoiceFetchPage(fetchXoroAll, { perPage = 100, module = "sales" } = {}) {
  return async function fetchPage(page) {
    const r = await fetchXoroAll({
      path: "invoice/getinvoice",
      params: { per_page: String(perPage) },
      maxPages: 1,
      module,
      pageStart: page,
    });
    const records = Array.isArray(r?.body?.Data) ? r.body.Data : [];
    // fetchXoroAll returns ok:true even on an empty page; a hard failure is
    // ok:false OR a non-array Data with a 4xx/5xx status.
    const hardFail = r?.ok === false;
    return {
      ok: !hardFail,
      records,
      totalPages: r?.body?.TotalPages ?? null,
      status: r?.status ?? 0,
    };
  };
}
