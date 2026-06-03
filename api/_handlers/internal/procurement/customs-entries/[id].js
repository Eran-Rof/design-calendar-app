// api/internal/procurement/customs-entries/:id  (h593)
//
// P13-C3 — Trade Compliance vertical, single customs-entry CRUD (data-only).
//
// GET    → header + customs_entry_lines (ordered).
// PATCH  → edit header + replace lines (delete-then-reinsert). The header
//          money rollups are always recomputed from the (possibly replaced)
//          line set so the header reconciles to its lines.
// DELETE → cascades lines (FK ON DELETE CASCADE).
//
// FINANCIALLY INERT: never posts a JE, never revalues FIFO, leaves
// revaluation_je_id NULL. The landed-cost revaluation JE is owned elsewhere.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

function optCents(val, label) {
  if (val == null || val === "") return { v: 0 };
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative integer (cents)` };
  return { v: n };
}
function optRate(val, label) {
  if (val == null || val === "") return { v: null };
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative number` };
  return { v: n };
}

// Normalize PATCH lines. Returns { error } or { lines }.
function normalizeLines(body) {
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const out = [];
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

    out.push({
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
  if (out.length === 0) return { error: "at least one customs entry line is required" };
  return { lines: out };
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = params?.id || req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: entry, error: eErr } = await admin
    .from("customs_entries")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (eErr) return res.status(500).json({ error: eErr.message });
  if (!entry) return res.status(404).json({ error: "Customs entry not found" });

  if (req.method === "GET") {
    const { data: lines, error: lErr } = await admin
      .from("customs_entry_lines")
      .select("*")
      .eq("customs_entry_id", id)
      .order("id", { ascending: true }); // lines have no created_at; id is stable order
    if (lErr) return res.status(500).json({ error: lErr.message });
    return res.status(200).json({ ...entry, lines: lines || [] });
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("customs_entries").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    const patch = {};
    if ("entry_number" in body) {
      const en = body.entry_number ? String(body.entry_number).trim() : "";
      if (!en) return res.status(400).json({ error: "entry_number cannot be empty" });
      patch.entry_number = en;
    }
    if ("entry_date" in body) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.entry_date || ""))) {
        return res.status(400).json({ error: "entry_date must be YYYY-MM-DD" });
      }
      patch.entry_date = body.entry_date;
    }
    if ("port_of_entry" in body) patch.port_of_entry = body.port_of_entry ? String(body.port_of_entry).trim() : null;
    if ("importer_of_record" in body) patch.importer_of_record = body.importer_of_record ? String(body.importer_of_record).trim() : null;
    if ("broker_name" in body) patch.broker_name = body.broker_name ? String(body.broker_name).trim() : null;
    if ("broker_id" in body) patch.broker_id = body.broker_id && UUID_RE.test(String(body.broker_id)) ? body.broker_id : null;
    if ("form_7501_document_id" in body) {
      patch.form_7501_document_id =
        body.form_7501_document_id && UUID_RE.test(String(body.form_7501_document_id)) ? body.form_7501_document_id : null;
    }
    if ("raw_payload" in body) {
      if (body.raw_payload == null) patch.raw_payload = {};
      else if (typeof body.raw_payload === "object" && !Array.isArray(body.raw_payload)) patch.raw_payload = body.raw_payload;
      else return res.status(400).json({ error: "raw_payload must be an object" });
    }
    if ("total_other_fees_cents" in body) {
      const o = optCents(body.total_other_fees_cents, "total_other_fees_cents");
      if (o.error) return res.status(400).json({ error: o.error });
      patch.total_other_fees_cents = o.v;
    }

    // Replace lines when supplied + recompute the header rollups from them.
    const replacingLines = Array.isArray(body.lines);
    let normLines = null;
    if (replacingLines) {
      const r = normalizeLines(body);
      if (r.error) return res.status(400).json({ error: r.error });
      normLines = r.lines;
      const sum = (k) => normLines.reduce((s, l) => s + (Number(l[k]) || 0), 0);
      patch.total_entered_value_cents = sum("entered_value_cents");
      patch.total_duty_cents = sum("duty_cents");
      patch.total_mpf_cents = sum("mpf_cents");
      patch.total_hmf_cents = sum("hmf_cents");
      patch.total_section_301_cents = sum("section_301_cents");
    }

    if (Object.keys(patch).length > 0) {
      const { error: uErr } = await admin.from("customs_entries").update(patch).eq("id", id);
      if (uErr) {
        if (uErr.code === "23505") return res.status(409).json({ error: `Entry number "${patch.entry_number}" already exists.` });
        return res.status(500).json({ error: uErr.message });
      }
    }

    if (replacingLines) {
      await admin.from("customs_entry_lines").delete().eq("customs_entry_id", id);
      const lineRows = normLines.map((l) => ({ ...l, customs_entry_id: id }));
      const { error: lErr } = await admin.from("customs_entry_lines").insert(lineRows);
      if (lErr) return res.status(500).json({ error: `Line update failed: ${lErr.message}` });
    }

    const { data: fresh, error: fErr } = await admin.from("customs_entries").select("*").eq("id", id).single();
    if (fErr) return res.status(500).json({ error: fErr.message });
    return res.status(200).json(fresh);
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
