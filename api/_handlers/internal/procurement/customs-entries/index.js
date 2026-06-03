// api/internal/procurement/customs-entries  (h592)
//
// P13-C3 — Trade Compliance vertical. CBP customs entries (CBP Form 7501)
// against received goods. Draft / data-only CRUD.
//
// GET  ?limit=  → customs entry headers for the default entity (newest first).
// POST { entry_number, entry_date, port_of_entry?, importer_of_record?,
//        broker_name?, broker_id?, form_7501_document_id?, raw_payload?,
//        lines: [{ receipt_line_item_id?, hts_code, country_of_origin,
//                  trade_program?, entered_value_cents, duty_rate_pct?,
//                  duty_cents?, section_301_rate_pct?, section_301_cents?,
//                  mpf_cents?, hmf_cents? }] }
//      → inserts the header + customs_entry_lines. The header dollar rollups
//        (total_entered_value/duty/mpf/hmf/section_301) are SUMMED from the
//        lines so the header always reconciles to its lines.
//
// FINANCIALLY INERT: this never writes a journal entry, never touches FIFO
// layers, and leaves revaluation_je_id NULL. The landed-cost revaluation JE
// onto inventory layers is owned by a separate chunk.
//
// Entity scoped. Writes via service-role (anon-read RLS).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data ? data.id : null;
}

const HEADER_COLS =
  "id, entity_id, entry_number, entry_date, port_of_entry, importer_of_record, " +
  "broker_name, broker_id, total_entered_value_cents, total_duty_cents, total_mpf_cents, " +
  "total_hmf_cents, total_section_301_cents, total_other_fees_cents, form_7501_document_id, " +
  "raw_payload, revaluation_je_id, created_at";

// Parse an optional non-negative integer cents field. Returns { error } or { v }.
function optCents(val, label) {
  if (val == null || val === "") return { v: 0 };
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative integer (cents)` };
  return { v: n };
}
// Parse an optional numeric rate (percent). Returns { error } or { v: number|null }.
function optRate(val, label) {
  if (val == null || val === "") return { v: null };
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative number` };
  return { v: n };
}

// Normalize + validate the POST/PATCH body. Returns { error } or { header, lines }.
// (Exported-shape helper reused by [id].js via copy — kept self-contained here.)
function validateInsert(body) {
  if (!body || typeof body !== "object") return { error: "body required" };

  const entryNumber = body.entry_number ? String(body.entry_number).trim() : "";
  if (!entryNumber) return { error: "entry_number required" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.entry_date || ""))) {
    return { error: "entry_date (YYYY-MM-DD) required" };
  }

  const lines = Array.isArray(body.lines) ? body.lines : [];
  const normLines = [];
  let ln = 0;
  for (const l of lines) {
    ln += 1;
    if (!l || typeof l !== "object") continue;
    const hts = l.hts_code ? String(l.hts_code).trim() : "";
    if (!hts) return { error: `line ${ln}: hts_code required` };
    const coo = l.country_of_origin ? String(l.country_of_origin).trim().toUpperCase() : "";
    if (!/^[A-Z]{2}$/.test(coo)) return { error: `line ${ln}: country_of_origin must be a 2-letter code` };

    const entered = optCents(l.entered_value_cents, `line ${ln}: entered_value_cents`);
    if (entered.error) return { error: entered.error };
    const duty = optCents(l.duty_cents, `line ${ln}: duty_cents`);
    if (duty.error) return { error: duty.error };
    const s301 = optCents(l.section_301_cents, `line ${ln}: section_301_cents`);
    if (s301.error) return { error: s301.error };
    const mpf = optCents(l.mpf_cents, `line ${ln}: mpf_cents`);
    if (mpf.error) return { error: mpf.error };
    const hmf = optCents(l.hmf_cents, `line ${ln}: hmf_cents`);
    if (hmf.error) return { error: hmf.error };

    const dutyRate = optRate(l.duty_rate_pct, `line ${ln}: duty_rate_pct`);
    if (dutyRate.error) return { error: dutyRate.error };
    const s301Rate = optRate(l.section_301_rate_pct, `line ${ln}: section_301_rate_pct`);
    if (s301Rate.error) return { error: s301Rate.error };

    normLines.push({
      // receipt_line_item_id references the LEGACY receipt_line_items; for native
      // receipts there is no row to point at, so store qty/value directly + null.
      receipt_line_item_id:
        l.receipt_line_item_id && UUID_RE.test(String(l.receipt_line_item_id)) ? l.receipt_line_item_id : null,
      hts_code: hts,
      country_of_origin: coo,
      trade_program: l.trade_program ? String(l.trade_program).trim() : null,
      entered_value_cents: entered.v,
      duty_rate_pct: dutyRate.v,
      duty_cents: duty.v,
      section_301_rate_pct: s301Rate.v,
      section_301_cents: s301.v,
      mpf_cents: mpf.v,
      hmf_cents: hmf.v,
    });
  }
  if (normLines.length === 0) return { error: "at least one customs entry line is required" };

  // Header-level "other fees" is the only standalone money field; everything
  // else is rolled up from the lines so the header always reconciles.
  const otherFees = optCents(body.total_other_fees_cents, "total_other_fees_cents");
  if (otherFees.error) return { error: otherFees.error };

  const sum = (k) => normLines.reduce((s, l) => s + (Number(l[k]) || 0), 0);

  let rawPayload = {};
  if (body.raw_payload != null) {
    if (typeof body.raw_payload === "object" && !Array.isArray(body.raw_payload)) rawPayload = body.raw_payload;
    else return { error: "raw_payload must be an object" };
  }

  return {
    header: {
      entry_number: entryNumber,
      entry_date: body.entry_date,
      port_of_entry: body.port_of_entry ? String(body.port_of_entry).trim() : null,
      importer_of_record: body.importer_of_record ? String(body.importer_of_record).trim() : null,
      broker_name: body.broker_name ? String(body.broker_name).trim() : null,
      broker_id: body.broker_id && UUID_RE.test(String(body.broker_id)) ? body.broker_id : null,
      total_entered_value_cents: sum("entered_value_cents"),
      total_duty_cents: sum("duty_cents"),
      total_mpf_cents: sum("mpf_cents"),
      total_hmf_cents: sum("hmf_cents"),
      total_section_301_cents: sum("section_301_cents"),
      total_other_fees_cents: otherFees.v,
      form_7501_document_id:
        body.form_7501_document_id && UUID_RE.test(String(body.form_7501_document_id))
          ? body.form_7501_document_id
          : null,
      raw_payload: rawPayload,
      // revaluation_je_id intentionally omitted — left NULL (owned elsewhere).
    },
    lines: normLines,
  };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    let limit = parseInt(url.searchParams.get("limit") || "200", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    limit = Math.min(limit, 1000);

    const { data, error } = await admin
      .from("customs_entries")
      .select(HEADER_COLS + ", customs_entry_lines(id)")
      .eq("entity_id", entityId)
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });

    const out = (data || []).map((row) => {
      const lines = Array.isArray(row.customs_entry_lines) ? row.customs_entry_lines : [];
      const { customs_entry_lines, ...header } = row; // eslint-disable-line no-unused-vars
      return { ...header, line_count: lines.length };
    });
    return res.status(200).json(out);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    const v = validateInsert(body);
    if (v.error) return res.status(400).json({ error: v.error });

    const { data: header, error: hErr } = await admin
      .from("customs_entries")
      .insert({
        // entity_id omitted — DB default rof_entity_id()
        ...v.header,
      })
      .select(HEADER_COLS)
      .single();
    if (hErr) {
      // Friendly message for the UNIQUE(entry_number per entity) violation.
      if (hErr.code === "23505") return res.status(409).json({ error: `Entry number "${v.header.entry_number}" already exists.` });
      return res.status(500).json({ error: hErr.message });
    }

    const lineRows = v.lines.map((l) => ({ ...l, customs_entry_id: header.id }));
    const { error: lErr } = await admin.from("customs_entry_lines").insert(lineRows);
    if (lErr) return res.status(500).json({ error: `Entry saved (${header.id}) but lines failed: ${lErr.message}` });

    return res.status(201).json(header);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
