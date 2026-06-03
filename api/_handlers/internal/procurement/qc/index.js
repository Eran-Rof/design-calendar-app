// api/internal/procurement/qc  (h590)
//
// P13-C2 — QC Inspections vertical. Quality-control inspections recorded
// against a goods-receipt (tanda_po_receipts). FINANCIALLY INERT: this records
// inspection results + findings only. NO journal entries, NO GL posting, NO AP.
// Any disposition → write-off / credit / RMA GL posting is a FUTURE chunk.
//
// GET  ?receipt_id=&status=  → inspections for the default entity (newest
//      first), each embedding the receipt's PO# + a findings count.
// POST { receipt_id (uuid req), inspection_date (req), inspector_employee_id?,
//        status?, notes?,
//        findings?: [{ category, severity, qty_affected?, description,
//                      resolution? }] }
//      → validates the receipt belongs to this entity, inserts the inspection
//        (+ findings). overall_pass_rate is computed from accepted/total when
//        the caller passes them, else left null.
//
// Entity scoped. Writes via service-role (anon-read RLS).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QC_STATUSES = ["pending", "passed", "failed", "partial"];
const SEVERITIES = ["minor", "major", "critical"];

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

const INSPECTION_COLS =
  "id, entity_id, receipt_id, inspection_date, inspector_employee_id, status, " +
  "overall_pass_rate, notes, created_at";

// Normalize + validate a findings array (shared shape with [id].js). Returns
// { error } or { findings }.
export function normalizeFindings(body) {
  const findings = Array.isArray(body.findings) ? body.findings : [];
  const out = [];
  let fn = 0;
  for (const f of findings) {
    fn += 1;
    if (!f || typeof f !== "object") continue;
    // A wholly-blank row from the UI is silently skipped.
    if (!f.category && !f.severity && !f.description) continue;
    const category = f.category ? String(f.category).trim() : "";
    if (!category) return { error: `finding ${fn}: category required` };
    const severity = f.severity ? String(f.severity).trim() : "";
    if (!SEVERITIES.includes(severity)) {
      return { error: `finding ${fn}: severity must be one of ${SEVERITIES.join(", ")}` };
    }
    const description = f.description ? String(f.description).trim() : "";
    if (!description) return { error: `finding ${fn}: description required` };
    let qty = f.qty_affected == null || f.qty_affected === "" ? 0 : Math.round(Number(f.qty_affected));
    if (!Number.isFinite(qty) || qty < 0) return { error: `finding ${fn}: qty_affected must be >= 0` };
    out.push({
      category,
      severity,
      qty_affected: qty,
      description,
      photo_urls: Array.isArray(f.photo_urls) ? f.photo_urls.map((u) => String(u)) : null,
      resolution: f.resolution ? String(f.resolution).trim() : null,
    });
  }
  return { findings: out };
}

// Compute overall_pass_rate (numeric(5,4), 0..1) from caller-supplied
// accepted/total when both are present + valid; otherwise null.
export function computePassRate(body) {
  const total = Number(body.total_qty ?? body.qty_total);
  const accepted = Number(body.accepted_qty ?? body.qty_accepted);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(accepted) || accepted < 0) return null;
  const rate = Math.min(1, accepted / total);
  return Math.round(rate * 10000) / 10000;
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
    const receiptId = (url.searchParams.get("receipt_id") || "").trim();
    const status = (url.searchParams.get("status") || "").trim();
    let limit = parseInt(url.searchParams.get("limit") || "200", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    limit = Math.min(limit, 500);
    if (status && !QC_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${QC_STATUSES.join(", ")}` });
    }

    let query = admin
      .from("tanda_po_qc_inspections")
      .select(
        INSPECTION_COLS +
          ", receipt:tanda_po_receipts!tanda_po_qc_inspections_receipt_id_fkey(id,purchase_order_id,receipt_date)" +
          ", tanda_po_qc_findings(id)",
      )
      .eq("entity_id", entityId)
      .order("inspection_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (receiptId && UUID_RE.test(receiptId)) query = query.eq("receipt_id", receiptId);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Flatten the embedded findings array into a count; drop the raw rows.
    const out = (data || []).map((row) => {
      const findings = Array.isArray(row.tanda_po_qc_findings) ? row.tanda_po_qc_findings : [];
      const { tanda_po_qc_findings, ...header } = row; // eslint-disable-line no-unused-vars
      return { ...header, findings_count: findings.length };
    });
    return res.status(200).json(out);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    if (!body.receipt_id || !UUID_RE.test(String(body.receipt_id))) {
      return res.status(400).json({ error: "receipt_id (uuid) required" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.inspection_date || ""))) {
      return res.status(400).json({ error: "inspection_date (YYYY-MM-DD) required" });
    }

    // The receipt must exist + belong to this entity.
    const { data: receipt, error: recErr } = await admin
      .from("tanda_po_receipts")
      .select("id, entity_id")
      .eq("id", body.receipt_id)
      .maybeSingle();
    if (recErr) return res.status(500).json({ error: recErr.message });
    if (!receipt || receipt.entity_id !== entityId) {
      return res.status(404).json({ error: "Receipt not found" });
    }

    let status = body.status ? String(body.status).trim() : "pending";
    if (!QC_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${QC_STATUSES.join(", ")}` });
    }

    const inspectorId =
      body.inspector_employee_id && UUID_RE.test(String(body.inspector_employee_id))
        ? body.inspector_employee_id
        : null;

    const f = normalizeFindings(body);
    if (f.error) return res.status(400).json({ error: f.error });

    const passRate = computePassRate(body);

    const { data: header, error: hErr } = await admin
      .from("tanda_po_qc_inspections")
      .insert({
        // entity_id omitted — DB default
        receipt_id: receipt.id,
        inspection_date: body.inspection_date,
        inspector_employee_id: inspectorId,
        status,
        overall_pass_rate: passRate,
        notes: body.notes ? String(body.notes).trim() : null,
      })
      .select(INSPECTION_COLS)
      .single();
    if (hErr) return res.status(500).json({ error: hErr.message });

    if (f.findings.length) {
      const rows = f.findings.map((x) => ({ ...x, inspection_id: header.id }));
      const { error: fErr } = await admin.from("tanda_po_qc_findings").insert(rows);
      if (fErr) {
        return res
          .status(500)
          .json({ error: `Inspection saved (${header.id}) but findings failed: ${fErr.message}` });
      }
    }

    return res.status(201).json(header);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
