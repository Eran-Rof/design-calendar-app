// api/internal/procurement/receipts/:id
//
// P13-C1 — Receiving vertical, single-receipt CRUD (draft only).
//
// GET    → receipt header + lines (with the embedded PO line for display) +
//          rollups (with the embedded expense GL account) + the parent PO header.
// PATCH  → drafts only (409 otherwise). Edit receipt_date/notes/received_by and
//          replace lines + rollups (delete-then-reinsert, mirroring the native
//          PO line-replace pattern).
// DELETE → drafts only. Cascades lines + rollups.
//
// The POST → FIFO + AP posting transition lives in ./[id]/post.js (owned
// elsewhere). This handler never posts.

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

// Normalize PATCH lines against the parent PO's line costs. Returns { error } or
// { lines }. Mirrors the index.js insert normalizer but for replacement.
function normalizeLines(body, poLineCosts) {
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const out = [];
  let ln = 0;
  for (const l of lines) {
    ln += 1;
    const polId = l && l.purchase_order_line_id;
    if (!polId || !UUID_RE.test(String(polId))) return { error: `line ${ln}: purchase_order_line_id (uuid) required` };
    if (!poLineCosts.has(String(polId))) return { error: `line ${ln}: purchase_order_line_id does not belong to this PO` };
    const recv = Number(l.qty_received);
    if (!Number.isFinite(recv) || recv <= 0) return { error: `line ${ln}: qty_received must be > 0` };
    const accepted = l.qty_accepted == null || l.qty_accepted === "" ? recv : Number(l.qty_accepted);
    if (!Number.isFinite(accepted) || accepted < 0) return { error: `line ${ln}: qty_accepted must be >= 0` };
    const rejected = l.qty_rejected == null || l.qty_rejected === "" ? 0 : Number(l.qty_rejected);
    if (!Number.isFinite(rejected) || rejected < 0) return { error: `line ${ln}: qty_rejected must be >= 0` };
    let unit = l.unit_cost_cents;
    if (unit == null || unit === "") unit = poLineCosts.get(String(polId));
    unit = Math.round(Number(unit));
    if (!Number.isFinite(unit) || unit < 0) return { error: `line ${ln}: unit_cost_cents must be >= 0` };
    out.push({
      purchase_order_line_id: polId,
      po_line_item_id: null,
      qty_received: Math.round(recv),
      qty_accepted: Math.round(accepted),
      qty_rejected: Math.round(rejected),
      unit_cost_cents: unit,
      landed_unit_cost_cents: null,
      inventory_layer_id: null,
      inventory_location_id:
        l.inventory_location_id && UUID_RE.test(String(l.inventory_location_id)) ? l.inventory_location_id : null,
      raw_payload: null,
    });
  }
  if (out.length === 0) return { error: "at least one line with qty_received > 0 is required" };
  return { lines: out };
}

function normalizeRollups(body) {
  const rollups = Array.isArray(body.rollups) ? body.rollups : [];
  const out = [];
  let rn = 0;
  for (const r of rollups) {
    rn += 1;
    if (!r || typeof r !== "object") continue;
    if (!r.expense_gl_account_id && (r.amount_cents == null || r.amount_cents === "") && !r.description) continue;
    if (!r.expense_gl_account_id || !UUID_RE.test(String(r.expense_gl_account_id))) return { error: `rollup ${rn}: expense_gl_account_id (uuid) required` };
    const amt = Math.round(Number(r.amount_cents));
    if (!Number.isFinite(amt) || amt <= 0) return { error: `rollup ${rn}: amount_cents must be > 0` };
    const desc = r.description ? String(r.description).trim() : "";
    if (!desc) return { error: `rollup ${rn}: description required` };
    out.push({
      expense_gl_account_id: r.expense_gl_account_id,
      amount_cents: amt,
      vendor_id: r.vendor_id && UUID_RE.test(String(r.vendor_id)) ? r.vendor_id : null,
      description: desc,
      capitalized_to_inventory: r.capitalized_to_inventory === false ? false : true,
      auto_invoice_id: null,
    });
  }
  return { rollups: out };
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = params?.id || req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: receipt, error: rErr } = await admin
    .from("tanda_po_receipts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (rErr) return res.status(500).json({ error: rErr.message });
  if (!receipt) return res.status(404).json({ error: "Receipt not found" });

  if (req.method === "GET") {
    const { data: lines, error: lErr } = await admin
      .from("tanda_po_receipt_lines")
      .select(
        "*, purchase_order_line:purchase_order_lines!tanda_po_receipt_lines_purchase_order_line_id_fkey" +
          "(line_number,description,inventory_item_id,qty_ordered,unit_cost_cents)",
      )
      .eq("receipt_id", id)
      .order("id", { ascending: true }); // receipt_lines has no created_at; id is a stable order
    if (lErr) return res.status(500).json({ error: lErr.message });

    const { data: rollups, error: roErr } = await admin
      .from("tanda_po_receipt_rollups")
      .select("*, expense_gl_account:gl_accounts!tanda_po_receipt_rollups_expense_gl_account_id_fkey(code,name)")
      .eq("receipt_id", id)
      .order("created_at", { ascending: true });
    if (roErr) return res.status(500).json({ error: roErr.message });

    let purchase_order = null;
    if (receipt.purchase_order_id) {
      const { data: po } = await admin
        .from("purchase_orders")
        .select("id, po_number, vendor_id, status, order_date, expected_date, currency, total_cents")
        .eq("id", receipt.purchase_order_id)
        .maybeSingle();
      purchase_order = po || null;
    }

    return res.status(200).json({ ...receipt, lines: lines || [], rollups: rollups || [], purchase_order });
  }

  if (req.method === "DELETE") {
    if (receipt.status !== "draft") {
      return res.status(409).json({ error: "Only a draft receipt can be deleted." });
    }
    const { error } = await admin.from("tanda_po_receipts").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    if (receipt.status !== "draft") {
      return res.status(409).json({ error: "Only a draft receipt can be edited." });
    }
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    const patch = {};
    if ("receipt_date" in body) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.receipt_date || ""))) {
        return res.status(400).json({ error: "receipt_date must be YYYY-MM-DD" });
      }
      patch.receipt_date = body.receipt_date;
    }
    if ("notes" in body) patch.notes = body.notes ? String(body.notes).trim() : null;
    if ("received_by_employee_id" in body) {
      patch.received_by_employee_id =
        body.received_by_employee_id && UUID_RE.test(String(body.received_by_employee_id))
          ? body.received_by_employee_id
          : null;
    }

    // Replace lines / rollups when supplied. Need the parent PO's line costs to
    // validate + default unit costs.
    const replacingLines = Array.isArray(body.lines);
    const replacingRollups = Array.isArray(body.rollups);

    let normLines = null;
    let normRollups = null;
    if (replacingLines || replacingRollups) {
      if (!receipt.purchase_order_id) {
        return res.status(409).json({ error: "Receipt has no native purchase order to validate against." });
      }
      if (replacingLines) {
        const { data: poLines, error: plErr } = await admin
          .from("purchase_order_lines")
          .select("id, unit_cost_cents")
          .eq("purchase_order_id", receipt.purchase_order_id);
        if (plErr) return res.status(500).json({ error: plErr.message });
        const poLineCosts = new Map((poLines || []).map((l) => [String(l.id), Number(l.unit_cost_cents) || 0]));
        const r = normalizeLines(body, poLineCosts);
        if (r.error) return res.status(400).json({ error: r.error });
        normLines = r.lines;
      }
      if (replacingRollups) {
        const r = normalizeRollups(body);
        if (r.error) return res.status(400).json({ error: r.error });
        normRollups = r.rollups;
      }
    }

    if (replacingLines) {
      await admin.from("tanda_po_receipt_lines").delete().eq("receipt_id", id);
      const lineRows = normLines.map((l) => ({ ...l, receipt_id: id }));
      const { error: lErr } = await admin.from("tanda_po_receipt_lines").insert(lineRows);
      if (lErr) return res.status(500).json({ error: `Line update failed: ${lErr.message}` });
    }

    if (replacingRollups) {
      await admin.from("tanda_po_receipt_rollups").delete().eq("receipt_id", id);
      if (normRollups.length) {
        const rollupRows = normRollups.map((r) => ({ ...r, receipt_id: id }));
        const { error: roErr } = await admin.from("tanda_po_receipt_rollups").insert(rollupRows);
        if (roErr) return res.status(500).json({ error: `Rollup update failed: ${roErr.message}` });
      }
      // Recompute the capitalized landed cost on the header.
      patch.landed_cost_cents = normRollups
        .filter((r) => r.capitalized_to_inventory)
        .reduce((s, r) => s + r.amount_cents, 0);
    }

    if (Object.keys(patch).length > 0) {
      const { error: uErr } = await admin.from("tanda_po_receipts").update(patch).eq("id", id);
      if (uErr) return res.status(500).json({ error: uErr.message });
    }

    const { data: fresh, error: fErr } = await admin.from("tanda_po_receipts").select("*").eq("id", id).single();
    if (fErr) return res.status(500).json({ error: fErr.message });
    return res.status(200).json(fresh);
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
