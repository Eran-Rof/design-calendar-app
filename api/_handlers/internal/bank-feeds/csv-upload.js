// api/internal/bank-feeds/csv-upload
//
// POST. Body: {
//   bank_account_id: <uuid>,
//   csv_text: <string>,            // raw CSV content
//   column_mapping?: {              // optional override; falls back to inferred
//     date, amount (and amount_sign), debit, credit, description
//   },
//   save_mapping?: boolean,         // persist column_mapping on bank_accounts row
//   dry_run?: boolean               // parse + return counts, no inserts
// }
//
// Parses the CSV, infers/uses the column mapping, normalizes each row,
// upserts into bank_transactions with source='csv_upload'. The
// external_txn_id is a stable hash of (date|amount|description) so re-
// uploading the same file no-ops via ON CONFLICT DO NOTHING.
//
// Tangerine P6-3.

import { createClient } from "@supabase/supabase-js";
import { parseCsv, inferColumnMapping, normalizeRow } from "../../../_lib/bank-feeds/csvParser.js";

export const config = { maxDuration: 60 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CSV_BYTES = 5 * 1024 * 1024;     // 5 MB hard cap (bank statements ~50 KB typically)
const MAX_ROWS = 10_000;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function validateBody(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.bank_account_id || !UUID_RE.test(String(body.bank_account_id))) {
    return { error: "bank_account_id (uuid) is required" };
  }
  if (!body.csv_text || typeof body.csv_text !== "string") {
    return { error: "csv_text (string) is required" };
  }
  const csvBytes = Buffer.byteLength(body.csv_text, "utf8");
  if (csvBytes > MAX_CSV_BYTES) {
    return { error: `csv_text exceeds ${MAX_CSV_BYTES} bytes (got ${csvBytes})` };
  }

  let mapping = null;
  if (body.column_mapping != null) {
    if (typeof body.column_mapping !== "object" || Array.isArray(body.column_mapping)) {
      return { error: "column_mapping must be an object" };
    }
    const allowed = ["date","amount","debit","credit","description","amount_sign"];
    mapping = {};
    for (const k of allowed) {
      if (body.column_mapping[k] != null) mapping[k] = body.column_mapping[k];
    }
    if (mapping.amount_sign != null && !["as_is","invert"].includes(mapping.amount_sign)) {
      return { error: "column_mapping.amount_sign must be 'as_is' or 'invert'" };
    }
  }

  return {
    data: {
      bank_account_id: String(body.bank_account_id),
      csv_text: body.csv_text,
      column_mapping: mapping,
      save_mapping: body.save_mapping === true,
      dry_run: body.dry_run === true,
    },
  };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Resolve the bank account + its existing mapping (if any).
  const { data: bankAccount, error: baErr } = await admin
    .from("bank_accounts")
    .select("id, entity_id, name, csv_column_mapping, is_active")
    .eq("id", v.data.bank_account_id)
    .maybeSingle();
  if (baErr) return res.status(500).json({ error: baErr.message });
  if (!bankAccount) return res.status(404).json({ error: "bank_account not found" });
  if (!bankAccount.is_active) return res.status(409).json({ error: "bank_account is not active" });

  // Parse CSV
  let parsed;
  try { parsed = parseCsv(v.data.csv_text); }
  catch (e) {
    return res.status(400).json({ error: `CSV parse failed: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (parsed.rows.length === 0) {
    return res.status(400).json({ error: "CSV has no data rows" });
  }
  if (parsed.rows.length > MAX_ROWS) {
    return res.status(400).json({ error: `CSV has ${parsed.rows.length} rows; max ${MAX_ROWS}` });
  }

  // Resolve column mapping: body > stored > inferred
  let mapping = v.data.column_mapping
    || bankAccount.csv_column_mapping
    || inferColumnMapping(parsed.headers);

  if (!mapping || !mapping.date) {
    return res.status(400).json({
      error: "Could not infer a date column. Pass column_mapping in the request or set bank_accounts.csv_column_mapping.",
      headers_seen: parsed.headers,
      inferred_mapping: inferColumnMapping(parsed.headers),
    });
  }
  if (!mapping.amount && !(mapping.debit || mapping.credit)) {
    return res.status(400).json({
      error: "column_mapping needs 'amount' OR both 'debit' + 'credit'",
      headers_seen: parsed.headers,
      inferred_mapping: inferColumnMapping(parsed.headers),
    });
  }

  // Normalize each row.
  const normalized = [];
  const skipped = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const r = normalizeRow(parsed.rows[i], mapping);
    if (r.error) {
      skipped.push({ row_index: i + 1, reason: r.error });
      continue;
    }
    normalized.push({
      ...r.row,
      entity_id: bankAccount.entity_id,
      bank_account_id: bankAccount.id,
    });
  }

  if (v.data.dry_run) {
    return res.status(200).json({
      dry_run: true,
      rows_parsed: parsed.rows.length,
      rows_normalized: normalized.length,
      rows_skipped: skipped.length,
      mapping_used: mapping,
      headers_seen: parsed.headers,
      skipped_preview: skipped.slice(0, 10),
      first_normalized_preview: normalized.slice(0, 5),
    });
  }

  // Persist column mapping if requested.
  if (v.data.save_mapping) {
    await admin
      .from("bank_accounts")
      .update({ csv_column_mapping: mapping })
      .eq("id", bankAccount.id);
  }

  // Upsert in chunks to keep request size manageable.
  const CHUNK = 500;
  let inserted = 0;
  let conflicts = 0;
  const errors = [];
  for (let i = 0; i < normalized.length; i += CHUNK) {
    const slice = normalized.slice(i, i + CHUNK);
    const { error: upErr, count } = await admin
      .from("bank_transactions")
      .upsert(slice, { onConflict: "bank_account_id,external_txn_id", ignoreDuplicates: true, count: "exact" });
    if (upErr) {
      errors.push({ chunk_start: i, error: upErr.message });
      continue;
    }
    if (typeof count === "number") {
      inserted += count;
      conflicts += slice.length - count;
    } else {
      inserted += slice.length;
    }
  }

  return res.status(200).json({
    dry_run: false,
    bank_account_id: bankAccount.id,
    rows_parsed: parsed.rows.length,
    rows_normalized: normalized.length,
    rows_skipped: skipped.length,
    rows_inserted: inserted,
    rows_conflicts: conflicts,
    mapping_used: mapping,
    mapping_saved: v.data.save_mapping === true,
    skipped_sample: skipped.slice(0, 25),
    errors,
  });
}
