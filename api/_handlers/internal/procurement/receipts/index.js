// api/internal/procurement/receipts
//
// Tangerine P13-3 — Procurement receiving handler (M38).
//
// GET   — list tanda_po_receipts filtered to status IN
//         ('draft','pending_approval','approved') by default. Optional:
//           ?status=<draft|pending_approval|approved|posted>
//           ?po_id=<uuid>     (filter to receipts for one PO)
//           ?from / ?to       (receipt_date window)
//           ?limit=N (default 200, max 500)
//           ?include_posted=true
// POST  — create a draft receipt. Body:
//           {
//             tanda_po_id (uuid — references tanda_pos.id),
//             receipt_date (YYYY-MM-DD; defaults today),
//             received_by_employee_id?, notes?,
//             lines: [
//               { po_line_item_id (uuid), qty_received (int > 0),
//                 qty_accepted (int >= 0), qty_rejected? (int >= 0),
//                 unit_cost_cents (int >= 0), inventory_location_id? }
//             ],
//             rollups?: [               // optional D19 rollups at create time
//               { expense_gl_account_id (uuid), amount_cents (int > 0),
//                 vendor_id?, description, capitalized_to_inventory? }
//             ]
//           }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = ["draft", "pending_approval", "approved", "posted"];
const ACTIVE_STATUSES = ["draft", "pending_approval", "approved"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntity(admin) {
  const { data } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  return data?.id || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const status      = (url.searchParams.get("status") || "").trim();
    const poId        = (url.searchParams.get("po_id") || "").trim();
    const from        = (url.searchParams.get("from") || "").trim();
    const to          = (url.searchParams.get("to") || "").trim();
    const includeP    = url.searchParams.get("include_posted") === "true";
    let limit = parseInt(url.searchParams.get("limit") || "200", 10);
    if (Number.isNaN(limit) || limit < 1) limit = 200;
    if (limit > 500) limit = 500;

    if (status && !STATUS_VALUES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${STATUS_VALUES.join(", ")}` });
    }
    if (poId && !UUID_RE.test(poId)) {
      return res.status(400).json({ error: "po_id must be a uuid" });
    }
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return res.status(400).json({ error: "from must be YYYY-MM-DD" });
    }
    if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: "to must be YYYY-MM-DD" });
    }

    let query = admin
      .from("tanda_po_receipts")
      .select(
        "id, entity_id, tanda_po_id, receipt_date, received_by_employee_id, " +
        "status, landed_cost_cents, notes, je_id, created_at, updated_at"
      )
      .order("receipt_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq("status", status);
    } else if (!includeP) {
      query = query.in("status", ACTIVE_STATUSES);
    }
    if (poId) query = query.eq("tanda_po_id", poId);
    if (from) query = query.gte("receipt_date", from);
    if (to)   query = query.lte("receipt_date", to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateReceiptInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const entityId = await resolveDefaultEntity(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const { data: header, error: hErr } = await admin
      .from("tanda_po_receipts")
      .insert({
        entity_id: entityId,
        tanda_po_id: v.data.tanda_po_id,
        receipt_date: v.data.receipt_date,
        received_by_employee_id: v.data.received_by_employee_id,
        status: "draft",
        landed_cost_cents: 0,
        notes: v.data.notes,
      })
      .select()
      .single();
    if (hErr) return res.status(500).json({ error: hErr.message });

    if (v.data.lines.length > 0) {
      const lineRows = v.data.lines.map((ln) => ({
        receipt_id: header.id,
        po_line_item_id: ln.po_line_item_id,
        qty_received: ln.qty_received,
        qty_accepted: ln.qty_accepted,
        qty_rejected: ln.qty_rejected,
        unit_cost_cents: ln.unit_cost_cents,
        inventory_location_id: ln.inventory_location_id,
      }));
      const { error: lErr } = await admin
        .from("tanda_po_receipt_lines")
        .insert(lineRows);
      if (lErr) {
        await admin.from("tanda_po_receipts").delete().eq("id", header.id);
        return res.status(500).json({ error: `Failed to insert receipt lines: ${lErr.message}` });
      }
    }

    // Optional D19 rollups passed in body — defer to the save-rollups
    // service (replace pattern) which also folds landed_cost_cents.
    if (v.data.rollups.length > 0) {
      const result = await applyRollups(admin, header.id, entityId, v.data.rollups);
      if (result.error) {
        await admin.from("tanda_po_receipt_lines").delete().eq("receipt_id", header.id);
        await admin.from("tanda_po_receipts").delete().eq("id", header.id);
        return res.status(500).json({ error: `Failed to insert rollups: ${result.error}` });
      }
    }

    const { data: fresh } = await admin
      .from("tanda_po_receipts")
      .select("*")
      .eq("id", header.id)
      .maybeSingle();
    return res.status(201).json(fresh || header);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

export function validateReceiptInsert(body) {
  if (!body.tanda_po_id || !isUuid(body.tanda_po_id)) {
    return { error: "tanda_po_id (uuid) is required" };
  }
  const date = body.receipt_date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: "receipt_date must be YYYY-MM-DD" };
  }
  if (body.received_by_employee_id && !isUuid(body.received_by_employee_id)) {
    return { error: "received_by_employee_id must be a uuid" };
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return { error: "lines must be a non-empty array" };
  }

  const lines = [];
  for (let i = 0; i < body.lines.length; i++) {
    const ln = body.lines[i] || {};
    if (!isUuid(ln.po_line_item_id)) {
      return { error: `line ${i + 1}: po_line_item_id must be a uuid` };
    }
    const qr = parseInt(ln.qty_received, 10);
    if (!Number.isFinite(qr) || qr <= 0) {
      return { error: `line ${i + 1}: qty_received must be > 0` };
    }
    const qa = parseInt(ln.qty_accepted ?? qr, 10);
    if (!Number.isFinite(qa) || qa < 0) {
      return { error: `line ${i + 1}: qty_accepted must be >= 0` };
    }
    const qj = ln.qty_rejected === undefined || ln.qty_rejected === null ? 0 : parseInt(ln.qty_rejected, 10);
    if (!Number.isFinite(qj) || qj < 0) {
      return { error: `line ${i + 1}: qty_rejected must be >= 0` };
    }
    if (qa + qj > qr) {
      return { error: `line ${i + 1}: qty_accepted + qty_rejected (${qa + qj}) cannot exceed qty_received (${qr})` };
    }
    const uc = parseCents(ln.unit_cost_cents);
    if (uc.error) return { error: `line ${i + 1}: unit_cost_cents — ${uc.error}` };
    if (uc.value < 0n) return { error: `line ${i + 1}: unit_cost_cents must be >= 0` };
    if (ln.inventory_location_id && !isUuid(ln.inventory_location_id)) {
      return { error: `line ${i + 1}: inventory_location_id must be a uuid` };
    }
    lines.push({
      po_line_item_id: ln.po_line_item_id,
      qty_received: qr,
      qty_accepted: qa,
      qty_rejected: qj,
      unit_cost_cents: uc.value.toString(),
      inventory_location_id: ln.inventory_location_id || null,
    });
  }

  const rollupsBody = Array.isArray(body.rollups) ? body.rollups : [];
  const rollups = [];
  for (let i = 0; i < rollupsBody.length; i++) {
    const r = validateRollup(rollupsBody[i], i + 1);
    if (r.error) return { error: r.error };
    rollups.push(r.data);
  }

  return {
    data: {
      tanda_po_id: body.tanda_po_id,
      receipt_date: date,
      received_by_employee_id: body.received_by_employee_id || null,
      notes: body.notes ? String(body.notes).trim() : null,
      lines,
      rollups,
    },
  };
}

export function validateRollup(raw, lineNum) {
  const r = raw || {};
  if (!isUuid(r.expense_gl_account_id)) {
    return { error: `rollup ${lineNum}: expense_gl_account_id must be a uuid` };
  }
  const amt = parseCents(r.amount_cents);
  if (amt.error) return { error: `rollup ${lineNum}: amount_cents — ${amt.error}` };
  if (amt.value <= 0n) return { error: `rollup ${lineNum}: amount_cents must be > 0` };
  if (r.vendor_id && !isUuid(r.vendor_id)) {
    return { error: `rollup ${lineNum}: vendor_id must be a uuid if provided` };
  }
  const desc = (r.description || "").trim();
  if (!desc) return { error: `rollup ${lineNum}: description is required` };
  return {
    data: {
      expense_gl_account_id: r.expense_gl_account_id,
      amount_cents: amt.value.toString(),
      vendor_id: r.vendor_id || null,
      description: desc,
      capitalized_to_inventory: r.capitalized_to_inventory !== false,
    },
  };
}

// Shared rollup-application logic — replace pattern used by both POST
// (initial rollups) and save-rollups (replace existing).
export async function applyRollups(admin, receiptId, entityId, rollups) {
  // Delete existing rollups (and their auto-created AP invoices)
  const { data: existing } = await admin
    .from("tanda_po_receipt_rollups")
    .select("id, auto_invoice_id")
    .eq("receipt_id", receiptId);
  if (existing && existing.length > 0) {
    const invoiceIds = existing.map((r) => r.auto_invoice_id).filter(Boolean);
    if (invoiceIds.length > 0) {
      await admin.from("invoices").delete().in("id", invoiceIds);
    }
    await admin.from("tanda_po_receipt_rollups").delete().eq("receipt_id", receiptId);
  }

  if (rollups.length === 0) {
    await admin
      .from("tanda_po_receipts")
      .update({ landed_cost_cents: 0, updated_at: new Date().toISOString() })
      .eq("id", receiptId);
    return { data: { rollups: [], landed_cost_cents: 0 } };
  }

  // Find the receipt's PO vendor for fallback when rollup vendor_id omitted.
  const { data: receipt } = await admin
    .from("tanda_po_receipts")
    .select("tanda_po_id")
    .eq("id", receiptId)
    .maybeSingle();
  if (!receipt) return { error: "receipt not found during rollup apply" };
  const { data: po } = await admin
    .from("tanda_pos")
    .select("vendor_id")
    .eq("id", receipt.tanda_po_id)
    .maybeSingle();
  const poVendor = po?.vendor_id || null;

  let landed = 0n;
  const created = [];
  for (let i = 0; i < rollups.length; i++) {
    const r = rollups[i];
    const vendorForInvoice = r.vendor_id || poVendor;
    if (!vendorForInvoice) {
      return { error: `rollup ${i + 1}: no vendor_id and PO has no vendor — cannot auto-create AP invoice` };
    }
    // Auto-create AP invoice in pending_bookkeeper_approval gate (D19).
    const invoiceNumber = `AUTO-TPR-${receiptId.slice(0, 8)}-${i + 1}`;
    const { data: invoice, error: invErr } = await admin
      .from("invoices")
      .insert({
        entity_id: entityId,
        vendor_id: vendorForInvoice,
        invoice_number: invoiceNumber,
        invoice_kind: "vendor_bill",
        status: "pending_bookkeeper_approval",
        gl_status: "unposted",
        posting_date: new Date().toISOString().slice(0, 10),
        expense_account_id: r.expense_gl_account_id,
        is_receipt_rollup: true,
        rollup_parent_receipt_id: receiptId,
        description: r.description,
        source: "manual",
      })
      .select()
      .single();
    if (invErr) {
      return { error: `rollup ${i + 1}: failed to auto-create AP invoice: ${invErr.message}` };
    }

    // Insert one line on the invoice for the rollup amount.
    await admin.from("invoice_line_items").insert({
      invoice_id: invoice.id,
      line_number: 1,
      description: r.description,
      expense_account_id: r.expense_gl_account_id,
      quantity: 1,
      unit_cost_cents: r.amount_cents,
      tax_amount_cents: 0,
    });

    const { data: rollupRow, error: rErr } = await admin
      .from("tanda_po_receipt_rollups")
      .insert({
        entity_id: entityId,
        receipt_id: receiptId,
        expense_gl_account_id: r.expense_gl_account_id,
        amount_cents: r.amount_cents,
        vendor_id: r.vendor_id,
        description: r.description,
        capitalized_to_inventory: r.capitalized_to_inventory,
        auto_invoice_id: invoice.id,
      })
      .select()
      .single();
    if (rErr) {
      await admin.from("invoices").delete().eq("id", invoice.id);
      return { error: `rollup ${i + 1}: failed to insert rollup: ${rErr.message}` };
    }
    created.push(rollupRow);

    if (r.capitalized_to_inventory) {
      landed += BigInt(r.amount_cents);
    }
  }

  await admin
    .from("tanda_po_receipts")
    .update({ landed_cost_cents: landed.toString(), updated_at: new Date().toISOString() })
    .eq("id", receiptId);

  return { data: { rollups: created, landed_cost_cents: landed.toString() } };
}

function parseCents(raw) {
  if (raw === null || raw === undefined || raw === "") return { error: "missing" };
  if (typeof raw === "bigint") return { value: raw };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { error: "not finite" };
    if (!Number.isInteger(raw)) return { error: "must be an integer (cents)" };
    return { value: BigInt(raw) };
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!/^-?\d+$/.test(s)) return { error: `invalid integer cents: ${raw}` };
    try { return { value: BigInt(s) }; } catch { return { error: "could not parse" }; }
  }
  return { error: "must be number or string of integer cents" };
}
