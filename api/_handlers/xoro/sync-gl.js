// POST /api/xoro/sync-gl — Xoro GL-transaction mirror ingest (#xoro-gl-truth).
//
// The nightly rof_xoro_project/scripts/rest_gl_sync.py walks Xoro's
// accounting/getgltransactions endpoint (GL Details scope) in date windows,
// and POSTs each window's rows here as a gzipped JSON body (multipart field
// "gl", same upload shape/auth as /api/ap/sync-bills — a design-calendar-api
// Bearer token). The payload is:
//
//   { "rows": [ <raw Xoro GL row>, ... ],
//     "deleted_txn_numbers": [ <TxnNumber>, ... ] }
//
// Landing: xoro_gl_transactions, one row per posted GL leg.
//
// UPSERT SEMANTICS — delete-then-insert per TxnId. A transaction is the atomic
// unit (no field combination is unique — see the migration header). For every
// distinct TxnId in the batch we delete the existing mirror rows, then insert
// the fresh set with a 0-based per-txn `row_seq`. Fully idempotent regardless
// of row order; correctly handles edited transactions (row-count changes).
//
// DELETIONS — deleted_txn_numbers (Data.deletedTxnNumbers from the endpoint)
// are hard-deleted from the mirror by txn_number.
//
// Amount is stored VERBATIM with Xoro's sign (positive = debit, negative =
// credit; every txn nets to 0 in amount_home — see migration header).

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import formidable from "formidable";
import { createClient } from "@supabase/supabase-js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";

export const config = { api: { bodyParser: false }, maxDuration: 300 };

const RATE_LIMIT = { limit: 120, windowMs: 60 * 60 * 1000 };

function pickFile(files, ...keys) {
  for (const k of keys) {
    const v = files[k];
    if (v) return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

function readBody(file) {
  const buf = readFileSync(file.filepath);
  const name = String(file.originalFilename || "").toLowerCase();
  const isGzip = name.endsWith(".gz") || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b);
  const text = (isGzip ? gunzipSync(buf) : buf).toString("utf8");
  return JSON.parse(text);
}

// Xoro emits 'MM/DD/YYYY' or 'MM/DD/YYYY HH:MM:SS'. Return YYYY-MM-DD or null.
function toIsoDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim().split(" ")[0];
  if (!s || s.startsWith("01/01/0001")) return null;
  const p = s.split("/");
  if (p.length === 3) {
    const m = +p[0], d = +p[1], y = +p[2];
    if (!y || y < 1900) return null;
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  if (s.length === 10 && s[4] === "-" && s[7] === "-") return s;
  return null;
}

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const int = (v) => { const n = num(v); return n === null ? null : Math.trunc(n); };
const str = (v) => (v === null || v === undefined ? null : String(v));
const bool = (v) => (v === null || v === undefined ? null : Boolean(v));

function mapRow(r, rowSeq) {
  return {
    txn_id: str(r.TxnId),
    txn_type_id: int(r.TxnTypeId),
    txn_type_name: str(r.TxnTypeName),
    txn_number: str(r.TxnNumber),
    txn_date: toIsoDate(r.TxnDate),
    row_seq: rowSeq,
    entity_account_id: str(r.EntityAccountId),
    entity_full_name: str(r.EntityFullName),
    store_id: int(r.StoreId),
    store_name: str(r.StoreName),
    accounting_id: str(r.F_AccountingId),
    accounting_type_id: int(r.F_AccountingTypeId),
    accounting_type_name: str(r.F_AccountingTypeName),
    accounting_name: str(r.F_AccountingName),
    gl_code: str(r.GLCode),
    ref_id: int(r.RefId),
    ref_number: str(r.RefNumber),
    ref_number2: str(r.RefNumber2),
    amount: num(r.Amount),
    amount_home: num(r.AmountHomeCurrency),
    currency_id: int(r.CurrencyId),
    currency: str(r.CurrencyName),
    exchange_rate: num(r.ExchangeRate),
    item_id: str(r.ItemId),
    item_type_id: int(r.ItemTypeId),
    item_number: str(r.ItemNumber),
    qty: num(r.Qty),
    memo: str(r.Memo),
    description: str(r.Description),
    project_class_id: int(r.ProjectClassId),
    project_class_name: str(r.ProjectClassName),
    sales_rep_id: str(r.SalesRepId),
    custom_field: str(r.CustomField),
    is_adjusting: bool(r.IsAdjustingTransaction),
    reconciled: bool(r.ReconciledFlag),
    deposited: bool(r.DepositedFlag),
    create_dttm: str(r.CreateDttm),
    create_source: str(r.CreateSource),
    modify_dttm: str(r.ModifyDttm),
    modify_source: str(r.ModifySource),
    raw: r,
  };
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
  const rl = rateLimit(`xoro-sync-gl:${tok}`, RATE_LIMIT);
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

  const form = formidable({ maxFileSize: 60 * 1024 * 1024, multiples: false });
  let files;
  try {
    [, files] = await form.parse(req);
  } catch (e) {
    return res.status(400).json({ error: "Multipart parse error", details: e.message });
  }

  const file = pickFile(files, "gl", "gl_rows", "transactions");
  if (!file) {
    return res.status(400).json({ error: "Missing 'gl' field", details: "Expected gzipped JSON { rows, deleted_txn_numbers } (also accepts: gl_rows, transactions)" });
  }

  let payload;
  try {
    payload = readBody(file);
  } catch (e) {
    return res.status(400).json({ error: "JSON decode failed", details: e.message });
  }

  const rows = Array.isArray(payload?.rows) ? payload.rows : (Array.isArray(payload) ? payload : []);
  const deletedTxnNumbers = Array.isArray(payload?.deleted_txn_numbers) ? payload.deleted_txn_numbers.map(String) : [];

  const result = {
    rows_received: rows.length,
    txns_seen: 0,
    deleted_rows: 0,
    inserted_rows: 0,
    deleted_txn_rows: 0,
    errors: [],
  };

  // Group by TxnId, assign row_seq per group (insertion order).
  const byTxn = new Map();
  for (const r of rows) {
    const tid = str(r.TxnId);
    if (!tid) { result.errors.push({ reason: "row missing TxnId", ref: r.RefNumber || null }); continue; }
    let g = byTxn.get(tid);
    if (!g) { g = []; byTxn.set(tid, g); }
    g.push(r);
  }
  result.txns_seen = byTxn.size;

  const txnIds = [...byTxn.keys()];

  // 1. delete existing rows for the incoming txn_ids (batched)
  for (let i = 0; i < txnIds.length; i += 200) {
    const chunk = txnIds.slice(i, i + 200);
    const { error } = await admin.from("xoro_gl_transactions").delete().in("txn_id", chunk);
    if (error) { result.errors.push({ reason: `delete-by-txn failed: ${error.message}` }); }
    else result.deleted_rows += 0; // count not returned by delete without select
  }

  // 2. build insert rows with per-txn row_seq
  const insertRows = [];
  for (const [tid, group] of byTxn) {
    group.forEach((r, i) => insertRows.push(mapRow(r, i)));
  }

  // 3. bulk insert (chunks of 500)
  for (let i = 0; i < insertRows.length; i += 500) {
    const chunk = insertRows.slice(i, i + 500);
    const { error } = await admin.from("xoro_gl_transactions").insert(chunk);
    if (error) {
      result.errors.push({ reason: `insert failed (rows ${i}..${i + chunk.length}): ${error.message}` });
    } else {
      result.inserted_rows += chunk.length;
    }
  }

  // 4. hard-delete voided transactions by txn_number
  if (deletedTxnNumbers.length) {
    for (let i = 0; i < deletedTxnNumbers.length; i += 200) {
      const chunk = deletedTxnNumbers.slice(i, i + 200);
      const { error, count } = await admin.from("xoro_gl_transactions")
        .delete({ count: "exact" }).in("txn_number", chunk);
      if (error) result.errors.push({ reason: `deleted-txn purge failed: ${error.message}` });
      else result.deleted_txn_rows += count || 0;
    }
  }

  return res.status(200).json({ processed: true, ...result });
}
