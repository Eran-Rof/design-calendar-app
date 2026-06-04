// h596 — api/internal/procurement/vendor-invoice-drafts
//
// P13-C4 — Vendor-Invoice 3-Way Match vertical. A vendor's invoice arrives
// separately from the PO + the goods receipt; we stage it here and match it
// against the NATIVE purchase_orders + tanda_po_receipts before it becomes an
// AP invoice. DRAFT-ONLY: this module never posts a journal entry. "Approve"
// (in ./[id].js) creates an AP invoice DRAFT and the existing AP posting flow
// handles GL later.
//
// GET  ?status=  → vendor-invoice-draft headers for the default entity (newest
//      first), each with the embedded vendor name.
// POST { vendor_id, vendor_invoice_number, invoice_date, due_date?,
//        total_cents, purchase_order_id? }
//      → inserts a manual draft (source_kind='manual'). When purchase_order_id
//        is given, auto-finds that PO's posted receipts, sets matched_po_ids /
//        matched_receipt_ids, and computes the variance + three_way_match_status
//        per the D4 tolerance ($5 OR 2%, whichever is greater).
//
// Entity scoped. Writes via service-role (anon-read RLS).
//
// Mirrors api/_handlers/internal/procurement/receipts/index.js conventions.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MATCH_STATUSES = ["pending", "matched", "variance", "exception", "posted", "rejected"];
// A receipt is part of the match once it has been posted (its inventory layer
// exists). Earlier-stage receipts are still in flux.
const POSTED_RECEIPT_STATUSES = ["posted"];

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
  "id, entity_id, vendor_id, vendor_invoice_number, invoice_date, due_date, currency, " +
  "total_cents, source_kind, source_pdf_document_id, ocr_confidence_pct, three_way_match_status, " +
  "matched_po_ids, matched_receipt_ids, variance_cents, variance_reason, ap_invoice_id, " +
  "approved_by_user_id, approved_at, rejected_reason, created_at, updated_at";

// ────────────────────────────────────────────────────────────────────────
// Match engine (shared with [id].js's rematch path via copy — keep in sync).
//
// Compares the vendor invoice total against the received-and-accepted value of
// the linked PO's posted receipts:
//   received_value = Σ over receipt lines ( qty_accepted × PO-line unit_cost_cents )
//   variance_cents = total_cents − received_value
// Tolerance (D4): matched if |variance| ≤ max(500, round(0.02 × received_value)).
// No posted receipt at all → 'exception'.
// ────────────────────────────────────────────────────────────────────────
export function matchTolerance(receivedValue) {
  return Math.max(500, Math.round(0.02 * Math.abs(Number(receivedValue) || 0)));
}

// Given a native purchase_order_id, load its posted receipts + line costs and
// compute the match result. Returns { receiptIds, receivedValue, variance,
// status, tolerance }.
export async function computeMatchForPo(admin, entityId, totalCents, purchaseOrderId) {
  // PO line unit costs keyed by line id.
  const { data: poLines } = await admin
    .from("purchase_order_lines")
    .select("id, unit_cost_cents")
    .eq("purchase_order_id", purchaseOrderId);
  const poLineCosts = new Map((poLines || []).map((l) => [String(l.id), Number(l.unit_cost_cents) || 0]));

  // Posted receipts against this PO (entity-scoped).
  const { data: receipts } = await admin
    .from("tanda_po_receipts")
    .select("id, status")
    .eq("entity_id", entityId)
    .eq("purchase_order_id", purchaseOrderId)
    .in("status", POSTED_RECEIPT_STATUSES);
  const receiptIds = (receipts || []).map((r) => r.id);

  if (receiptIds.length === 0) {
    return { receiptIds: [], receivedValue: 0, variance: Number(totalCents) || 0, status: "exception", tolerance: matchTolerance(0) };
  }

  // Accepted qty per receipt line × the PO line's unit cost.
  const { data: rlines } = await admin
    .from("tanda_po_receipt_lines")
    .select("receipt_id, purchase_order_line_id, qty_accepted, unit_cost_cents")
    .in("receipt_id", receiptIds);

  let receivedValue = 0;
  for (const rl of rlines || []) {
    const accepted = Number(rl.qty_accepted) || 0;
    // Prefer the PO line's unit cost (the contracted price). Fall back to the
    // receipt line's recorded unit cost when the PO line can't be resolved.
    const polId = rl.purchase_order_line_id ? String(rl.purchase_order_line_id) : null;
    const unit = polId && poLineCosts.has(polId) ? poLineCosts.get(polId) : (Number(rl.unit_cost_cents) || 0);
    receivedValue += accepted * unit;
  }

  const variance = (Number(totalCents) || 0) - receivedValue;
  const tolerance = matchTolerance(receivedValue);
  const status = Math.abs(variance) <= tolerance ? "matched" : "variance";
  return { receiptIds, receivedValue, variance, status, tolerance };
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
    const status = (url.searchParams.get("status") || "").trim();
    let limit = parseInt(url.searchParams.get("limit") || "200", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    limit = Math.min(limit, 500);
    if (status && !MATCH_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${MATCH_STATUSES.join(", ")}` });
    }

    let query = admin
      .from("vendor_invoice_drafts")
      .select(HEADER_COLS + ", vendor:vendors!vendor_invoice_drafts_vendor_id_fkey(name)")
      .eq("entity_id", entityId)
      .order("invoice_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (status) query = query.eq("three_way_match_status", status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Flatten the embedded vendor into a vendor_name field for the list payload.
    const out = (data || []).map((row) => {
      const { vendor, ...header } = row; // eslint-disable-line no-unused-vars
      return { ...header, vendor_name: vendor && vendor.name ? vendor.name : null };
    });
    return res.status(200).json(out);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    if (!body.vendor_id || !UUID_RE.test(String(body.vendor_id))) {
      return res.status(400).json({ error: "vendor_id (uuid) required" });
    }
    const invNum = body.vendor_invoice_number ? String(body.vendor_invoice_number).trim() : "";
    if (!invNum) return res.status(400).json({ error: "vendor_invoice_number required" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.invoice_date || ""))) {
      return res.status(400).json({ error: "invoice_date (YYYY-MM-DD) required" });
    }
    if (body.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.due_date))) {
      return res.status(400).json({ error: "due_date must be YYYY-MM-DD" });
    }
    if (body.due_date && String(body.due_date) < String(body.invoice_date)) {
      return res.status(400).json({ error: "due_date cannot precede invoice_date" });
    }
    const totalCents = Math.round(Number(body.total_cents));
    if (!Number.isFinite(totalCents) || totalCents < 0) {
      return res.status(400).json({ error: "total_cents must be a non-negative integer (cents)" });
    }

    // Verify the vendor exists + belongs to this entity scope (vendors are
    // entity-scoped via default; a stray FK error otherwise becomes a 500).
    const { data: vendor, error: vErr } = await admin
      .from("vendors")
      .select("id")
      .eq("id", body.vendor_id)
      .maybeSingle();
    if (vErr) return res.status(500).json({ error: vErr.message });
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });

    // Optional PO prefill → auto-match.
    let matched_po_ids = [];
    let matched_receipt_ids = [];
    let variance_cents = 0;
    let three_way_match_status = "pending";
    let variance_reason = null;

    const poId = body.purchase_order_id ? String(body.purchase_order_id) : "";
    if (poId) {
      if (!UUID_RE.test(poId)) return res.status(400).json({ error: "purchase_order_id must be a uuid" });
      const { data: po, error: poErr } = await admin
        .from("purchase_orders")
        .select("id, entity_id")
        .eq("id", poId)
        .maybeSingle();
      if (poErr) return res.status(500).json({ error: poErr.message });
      if (!po || po.entity_id !== entityId) return res.status(404).json({ error: "Purchase order not found" });

      const m = await computeMatchForPo(admin, entityId, totalCents, poId);
      matched_po_ids = [poId];
      matched_receipt_ids = m.receiptIds;
      variance_cents = m.variance;
      three_way_match_status = m.status;
      if (m.status === "exception") variance_reason = "No posted receipt found for the linked PO.";
      else if (m.status === "variance") variance_reason = `Cost variance ${m.variance} cents exceeds tolerance ${m.tolerance} cents.`;
    }

    const { data: inserted, error: iErr } = await admin
      .from("vendor_invoice_drafts")
      .insert({
        // entity_id omitted — DB default coalesce(current_entity_id(), rof_entity_id())
        vendor_id: body.vendor_id,
        vendor_invoice_number: invNum,
        invoice_date: body.invoice_date,
        due_date: body.due_date || null,
        total_cents: totalCents,
        source_kind: "manual",
        matched_po_ids,
        matched_receipt_ids,
        variance_cents,
        variance_reason,
        three_way_match_status,
      })
      .select(HEADER_COLS)
      .single();
    if (iErr) {
      if (iErr.code === "23505") {
        return res.status(409).json({ error: "A draft with that invoice number already exists for this vendor." });
      }
      return res.status(500).json({ error: iErr.message });
    }

    return res.status(201).json(inserted);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
