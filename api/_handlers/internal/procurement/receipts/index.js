// api/internal/procurement/receipts
//
// P13-C1 — Receiving vertical. Goods-receipt sessions against a NATIVE
// purchase order (purchase_orders). Draft CRUD only — the POST → FIFO + AP
// posting lives in a separate ./[id]/post.js handler (owned elsewhere).
//
// GET  ?purchase_order_id=&status=  → receipt headers for the default entity
//      (newest first), each with the PO number/vendor + a line/qty summary.
// POST { purchase_order_id, receipt_date, received_by_employee_id?, notes?,
//        lines: [{ purchase_order_line_id, qty_received, qty_accepted?,
//                  qty_rejected?, unit_cost_cents? }],
//        rollups?: [{ expense_gl_account_id, amount_cents, vendor_id?,
//                     description, capitalized_to_inventory? }] }
//      → validates the PO is issued/in_transit, inserts a DRAFT receipt with
//        its lines (native: purchase_order_line_id set) + optional rollups.
//
// Entity scoped. Writes via service-role (anon-read RLS).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIPT_STATUSES = ["draft", "pending_approval", "approved", "posted"];
// A receipt can only be opened against a PO that has been issued and is
// in-flight; you cannot receive a draft/cancelled/already-received PO.
const RECEIVABLE_PO_STATUSES = ["issued", "in_transit"];

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
  "id, entity_id, tanda_po_id, purchase_order_id, receipt_date, received_by_employee_id, " +
  "status, landed_cost_cents, notes, je_id, created_at, updated_at";

// Normalize + validate the POST body. Returns { error } or { data }.
function validateInsert(body, poLineCosts) {
  if (!body || typeof body !== "object") return { error: "body required" };
  if (!body.purchase_order_id || !UUID_RE.test(String(body.purchase_order_id))) {
    return { error: "purchase_order_id (uuid) required" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.receipt_date || ""))) {
    return { error: "receipt_date (YYYY-MM-DD) required" };
  }

  const lines = Array.isArray(body.lines) ? body.lines : [];
  const normLines = [];
  let ln = 0;
  for (const l of lines) {
    ln += 1;
    const polId = l && l.purchase_order_line_id;
    if (!polId || !UUID_RE.test(String(polId))) {
      return { error: `line ${ln}: purchase_order_line_id (uuid) required` };
    }
    if (!poLineCosts.has(String(polId))) {
      return { error: `line ${ln}: purchase_order_line_id does not belong to this PO` };
    }
    const recv = Number(l.qty_received);
    if (!Number.isFinite(recv) || recv <= 0) {
      return { error: `line ${ln}: qty_received must be > 0` };
    }
    const accepted = l.qty_accepted == null || l.qty_accepted === "" ? recv : Number(l.qty_accepted);
    if (!Number.isFinite(accepted) || accepted < 0) {
      return { error: `line ${ln}: qty_accepted must be >= 0` };
    }
    const rejected = l.qty_rejected == null || l.qty_rejected === "" ? 0 : Number(l.qty_rejected);
    if (!Number.isFinite(rejected) || rejected < 0) {
      return { error: `line ${ln}: qty_rejected must be >= 0` };
    }
    // Default the unit cost from the PO line when omitted.
    let unit = l.unit_cost_cents;
    if (unit == null || unit === "") unit = poLineCosts.get(String(polId));
    unit = Math.round(Number(unit));
    if (!Number.isFinite(unit) || unit < 0) {
      return { error: `line ${ln}: unit_cost_cents must be >= 0` };
    }
    normLines.push({
      purchase_order_line_id: polId,
      po_line_item_id: null, // native PO path — leave the Xoro-PO column null
      qty_received: Math.round(recv),
      qty_accepted: Math.round(accepted),
      qty_rejected: Math.round(rejected),
      unit_cost_cents: unit,
      landed_unit_cost_cents: null, // set at post time
      inventory_layer_id: null,
      inventory_location_id:
        l.inventory_location_id && UUID_RE.test(String(l.inventory_location_id)) ? l.inventory_location_id : null,
      raw_payload: null,
    });
  }
  if (normLines.length === 0) return { error: "at least one line with qty_received > 0 is required" };

  const rollups = Array.isArray(body.rollups) ? body.rollups : [];
  const normRollups = [];
  let rn = 0;
  for (const r of rollups) {
    rn += 1;
    if (!r || typeof r !== "object") continue;
    // A blank/zero rollup row from the UI is silently skipped.
    if (!r.expense_gl_account_id && (r.amount_cents == null || r.amount_cents === "") && !r.description) continue;
    if (!r.expense_gl_account_id || !UUID_RE.test(String(r.expense_gl_account_id))) {
      return { error: `rollup ${rn}: expense_gl_account_id (uuid) required` };
    }
    const amt = Math.round(Number(r.amount_cents));
    if (!Number.isFinite(amt) || amt <= 0) {
      return { error: `rollup ${rn}: amount_cents must be > 0` };
    }
    const desc = r.description ? String(r.description).trim() : "";
    if (!desc) return { error: `rollup ${rn}: description required` };
    normRollups.push({
      expense_gl_account_id: r.expense_gl_account_id,
      amount_cents: amt,
      vendor_id: r.vendor_id && UUID_RE.test(String(r.vendor_id)) ? r.vendor_id : null,
      description: desc,
      capitalized_to_inventory: r.capitalized_to_inventory === false ? false : true,
      auto_invoice_id: null, // queued for the bookkeeper at post time
    });
  }

  return {
    data: {
      purchase_order_id: body.purchase_order_id,
      receipt_date: body.receipt_date,
      received_by_employee_id:
        body.received_by_employee_id && UUID_RE.test(String(body.received_by_employee_id))
          ? body.received_by_employee_id
          : null,
      notes: body.notes ? String(body.notes).trim() : null,
      lines: normLines,
      rollups: normRollups,
    },
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
    const purchaseOrderId = (url.searchParams.get("purchase_order_id") || "").trim();
    const status = (url.searchParams.get("status") || "").trim();
    let limit = parseInt(url.searchParams.get("limit") || "200", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    limit = Math.min(limit, 500);
    if (status && !RECEIPT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${RECEIPT_STATUSES.join(", ")}` });
    }

    let query = admin
      .from("tanda_po_receipts")
      .select(
        HEADER_COLS +
          ", purchase_order:purchase_orders!tanda_po_receipts_purchase_order_id_fkey(po_number,vendor_id)" +
          ", tanda_po_receipt_lines(qty_received,qty_accepted)",
      )
      .eq("entity_id", entityId)
      .order("receipt_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (purchaseOrderId && UUID_RE.test(purchaseOrderId)) query = query.eq("purchase_order_id", purchaseOrderId);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Flatten the embedded line array into a per-receipt summary; drop the raw
    // line rows from the list payload.
    const out = (data || []).map((row) => {
      const lines = Array.isArray(row.tanda_po_receipt_lines) ? row.tanda_po_receipt_lines : [];
      const total_received = lines.reduce((s, l) => s + (Number(l.qty_received) || 0), 0);
      const total_accepted = lines.reduce((s, l) => s + (Number(l.qty_accepted) || 0), 0);
      const { tanda_po_receipt_lines, ...header } = row; // eslint-disable-line no-unused-vars
      return { ...header, line_count: lines.length, total_received, total_accepted };
    });
    return res.status(200).json(out);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    if (!body.purchase_order_id || !UUID_RE.test(String(body.purchase_order_id))) {
      return res.status(400).json({ error: "purchase_order_id (uuid) required" });
    }

    // The PO must exist, belong to this entity, and be in a receivable status.
    const { data: po, error: poErr } = await admin
      .from("purchase_orders")
      .select("id, entity_id, status, po_number")
      .eq("id", body.purchase_order_id)
      .maybeSingle();
    if (poErr) return res.status(500).json({ error: poErr.message });
    if (!po) return res.status(404).json({ error: "Purchase order not found" });
    if (po.entity_id !== entityId) return res.status(404).json({ error: "Purchase order not found" });
    if (!RECEIVABLE_PO_STATUSES.includes(po.status)) {
      return res.status(409).json({
        error: `Purchase order must be ${RECEIVABLE_PO_STATUSES.join(" or ")} to receive (currently ${po.status}).`,
      });
    }

    // Load the PO's lines so we can validate the referenced line ids + default
    // each receipt line's unit cost from the PO.
    const { data: poLines, error: plErr } = await admin
      .from("purchase_order_lines")
      .select("id, unit_cost_cents")
      .eq("purchase_order_id", po.id);
    if (plErr) return res.status(500).json({ error: plErr.message });
    const poLineCosts = new Map((poLines || []).map((l) => [String(l.id), Number(l.unit_cost_cents) || 0]));

    const v = validateInsert(body, poLineCosts);
    if (v.error) return res.status(400).json({ error: v.error });

    const landedCost = v.data.rollups
      .filter((r) => r.capitalized_to_inventory)
      .reduce((s, r) => s + r.amount_cents, 0);

    const { data: header, error: hErr } = await admin
      .from("tanda_po_receipts")
      .insert({
        // entity_id omitted — DB default rof_entity_id()
        purchase_order_id: po.id,
        tanda_po_id: null, // native PO path
        receipt_date: v.data.receipt_date,
        received_by_employee_id: v.data.received_by_employee_id,
        status: "draft",
        landed_cost_cents: landedCost,
        notes: v.data.notes,
      })
      .select(HEADER_COLS)
      .single();
    if (hErr) return res.status(500).json({ error: hErr.message });

    const lineRows = v.data.lines.map((l) => ({ ...l, receipt_id: header.id }));
    const { error: lErr } = await admin.from("tanda_po_receipt_lines").insert(lineRows);
    if (lErr) return res.status(500).json({ error: `Receipt saved (${header.id}) but lines failed: ${lErr.message}` });

    if (v.data.rollups.length) {
      const rollupRows = v.data.rollups.map((r) => ({ ...r, receipt_id: header.id }));
      const { error: rErr } = await admin.from("tanda_po_receipt_rollups").insert(rollupRows);
      if (rErr) return res.status(500).json({ error: `Receipt saved (${header.id}) but rollups failed: ${rErr.message}` });
    }

    return res.status(201).json(header);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
