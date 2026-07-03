// POST /api/ap/sync-bills — REST AP-bill ingest from Xoro's bill/getbill.
//
// The nightly rof_xoro_project scripts/rest_ap_sync.py walks bill/getbill
// (AP-scoped private app), expands each bill's header + line array into one
// CSV row per (bill, line), gzips it, and POSTs it here as multipart field
// "bills" with a design-calendar-api Bearer token — the same upload shape as
// /api/master/sync.
//
// Landing: each bill becomes one `invoices` (AP) row with source='xoro_ap'
// (the authoritative real-bill feed) plus its `invoice_line_items`.
//
// SUPERSEDE semantics (while Xoro is the system of record, pre-Tangerine
// go-live): on a (vendor_id, invoice_number) collision —
//   - source='manual'      -> SKIP (never overwrite an operator-typed bill)
//   - source='xoro_mirror' -> UPDATE in place (real bill supersedes the
//                             T10 PO-derived synthetic bill)
//   - source='xoro_ap'     -> UPDATE in place (idempotent re-sync)
// We do NOT touch the T10 shadow-mirror GL engine (its summary JEs sum only
// source='xoro_mirror'); this is the operational AP record.
//
// Vendor resolution reuses xoro-mirror/ap.js::resolveVendorId (vendors.code
// then aliases match on Vendor Name). Unmatched vendors are skipped and
// surfaced in the response so the operator can add a vendor/alias.

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import formidable from "formidable";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";
import { resolveVendorId } from "../../_lib/xoro-mirror/ap.js";
import { parseBillRows, buildInvoicePayload, buildLineRows, makeItemResolver, parseItemNumber, billSinglePoNumber } from "../../_lib/ap-bill-sync.js";

// Fetch ip_item_master rows for the styles referenced by a batch of bills so
// each bill line can be linked to its SKU. Paginated OR-ilike by style prefix.
async function fetchMasterForBills(admin, bills) {
  const styles = [...new Set(bills.flatMap((b) => b.lines.map((l) => parseItemNumber(l.item_number)?.style).filter(Boolean)).map((s) => String(s).replace(/[^A-Za-z0-9]/g, "")))].filter(Boolean);
  const rows = [];
  const PAGE = 1000;
  for (let i = 0; i < styles.length; i += 25) {
    const orExpr = styles.slice(i, i + 25).map((s) => `style_code.ilike.${s}%`).join(",");
    if (!orExpr) continue;
    for (let from = 0; from < 50000; from += PAGE) {
      const { data, error } = await admin.from("ip_item_master").select("id, sku_code, style_code, color, size").or(orExpr).range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = data || [];
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
  }
  return rows;
}

export const config = { api: { bodyParser: false }, maxDuration: 300 };

const RATE_LIMIT = { limit: 12, windowMs: 60 * 60 * 1000 };

function pickFile(files, ...keys) {
  for (const k of keys) {
    const v = files[k];
    if (v) return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

function decompressIfGzipped(file) {
  if (!file) return null;
  const buf = readFileSync(file.filepath);
  const name = String(file.originalFilename || "").toLowerCase();
  const isGzip = name.endsWith(".gz")
    || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b);
  if (!isGzip) return file.filepath;
  const decompressed = gunzipSync(buf);
  const outPath = `${file.filepath}.decompressed`;
  writeFileSync(outPath, decompressed);
  return outPath;
}

function readCsvRows(filepath) {
  const buffer = readFileSync(filepath);
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateDesignCalendarCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const tok = String(req.headers.authorization || "").slice(-8);
  const rl = rateLimit(`ap-sync-bills:${tok}`, RATE_LIMIT);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retry_after_s));
    return res.status(rl.status).json({ error: rl.error, retry_after_s: rl.retry_after_s });
  }

  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "Supabase not configured (VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required)" });
  }
  const admin = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  const form = formidable({ maxFileSize: 50 * 1024 * 1024, multiples: false });
  let files;
  try {
    [, files] = await form.parse(req);
  } catch (e) {
    return res.status(400).json({ error: "Multipart parse error", details: e.message });
  }

  const file = pickFile(files, "bills", "ap_bills", "bill_detail");
  if (!file) {
    return res.status(400).json({
      error: "Missing 'bills' field",
      details: "Expected the BillDetail*.csv (gzip OK; also accepts: ap_bills, bill_detail)",
    });
  }

  let csvRows;
  try {
    const path = decompressIfGzipped(file);
    csvRows = readCsvRows(path);
  } catch (e) {
    return res.status(400).json({ error: "CSV decode failed", details: e.message });
  }

  const bills = parseBillRows(csvRows);
  const nowIso = new Date().toISOString();

  const result = {
    csv_rows: csvRows.length,
    bills_seen: bills.length,
    inserted: 0,
    updated: 0,
    skipped_manual: 0,
    line_rows_written: 0,
    unmatched_vendors: [],
    errors: [],
  };

  const vendorCache = new Map();

  // Item Number → SKU resolver so each bill line links to its ip_item_master
  // row (feeds the Inventory Snapshot Purchased drill). Best-effort: a build
  // failure must not block the bill sync, so degrade to no linkage.
  let resolveId = null;
  try { resolveId = makeItemResolver(await fetchMasterForBills(admin, bills)); }
  catch (e) { result.errors.push({ reason: `item resolver build failed: ${e?.message || String(e)}` }); }

  // Single-PO bill → Xoro PO uuid map, so invoices.po_id can be stamped (the AP
  // anomaly nightly matches one invoice to one PO by po_id and skips nulls).
  const poUuidByNumber = new Map();
  try {
    const poNums = [...new Set(bills.map(billSinglePoNumber).filter(Boolean))];
    for (let i = 0; i < poNums.length; i += 300) {
      const { data } = await admin.from("tanda_pos").select("po_number, uuid_id").in("po_number", poNums.slice(i, i + 300));
      for (const r of data || []) if (r.uuid_id) poUuidByNumber.set(r.po_number, r.uuid_id);
    }
  } catch (e) { result.errors.push({ reason: `po_id map build failed: ${e?.message || String(e)}` }); }

  for (const bill of bills) {
    // Resolve vendor by name (CSV "Vendor Code" is the Xoro int id, which
    // doesn't map to our vendors table — the name/alias match is the join).
    let vendor_id;
    try {
      vendor_id = await resolveVendorId(admin, { vendor: bill.vendor_name }, vendorCache);
    } catch (e) {
      result.errors.push({ invoice_number: bill.invoice_number, reason: `vendor resolution threw: ${e?.message || String(e)}` });
      continue;
    }
    if (!vendor_id) {
      result.unmatched_vendors.push({ invoice_number: bill.invoice_number, vendor_name: bill.vendor_name });
      continue;
    }

    // Probe for an existing (vendor_id, invoice_number) row.
    let existing;
    try {
      const { data, error } = await admin
        .from("invoices")
        .select("id, source")
        .eq("vendor_id", vendor_id)
        .eq("invoice_number", bill.invoice_number)
        .maybeSingle();
      if (error) {
        result.errors.push({ invoice_number: bill.invoice_number, reason: `existing-bill probe failed: ${error.message}` });
        continue;
      }
      existing = data || null;
    } catch (e) {
      result.errors.push({ invoice_number: bill.invoice_number, reason: `existing-bill probe threw: ${e?.message || String(e)}` });
      continue;
    }

    // Preserve operator-typed (and any non-xoro) bills.
    if (existing && existing.source && existing.source !== "xoro_mirror" && existing.source !== "xoro_ap") {
      result.skipped_manual += 1;
      continue;
    }

    const payload = buildInvoicePayload(bill, vendor_id, nowIso);
    const singlePo = billSinglePoNumber(bill);
    payload.po_id = (singlePo && poUuidByNumber.get(singlePo)) || null;

    let invoiceId;
    if (existing) {
      // Supersede xoro_mirror / idempotent re-sync of xoro_ap.
      const { error } = await admin.from("invoices").update(payload).eq("id", existing.id);
      if (error) {
        result.errors.push({ invoice_number: bill.invoice_number, reason: `update failed: ${error.message}` });
        continue;
      }
      invoiceId = existing.id;
      // Re-sync lines: delete-then-insert keeps it idempotent.
      const { error: delErr } = await admin.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
      if (delErr) {
        result.errors.push({ invoice_number: bill.invoice_number, reason: `line delete failed: ${delErr.message}` });
        // header already updated; continue to next bill
        result.updated += 1;
        continue;
      }
      result.updated += 1;
    } else {
      const { data, error } = await admin.from("invoices").insert(payload).select("id").maybeSingle();
      if (error || !data) {
        result.errors.push({ invoice_number: bill.invoice_number, reason: `insert failed: ${error?.message || "no row returned"}` });
        continue;
      }
      invoiceId = data.id;
      result.inserted += 1;
    }

    const lineRows = buildLineRows(bill, invoiceId, resolveId);
    if (lineRows.length > 0) {
      const { error: lineErr } = await admin.from("invoice_line_items").insert(lineRows);
      if (lineErr) {
        // Header is authoritative; surface line failure but don't roll back.
        result.errors.push({ invoice_number: bill.invoice_number, reason: `line insert failed: ${lineErr.message}` });
      } else {
        result.line_rows_written += lineRows.length;
      }
    }
  }

  return res.status(200).json({ processed: true, ...result });
}
