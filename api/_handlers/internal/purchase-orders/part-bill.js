// api/internal/purchase-orders/[id]/part-bill
//
// POST — enter the vendor's AP bill for a received MANUFACTURING-PART PO and
//        3-way match it against the PO + its posted goods receipts.
//
// The parts were booked into inventory at receipt (partInventoryReceipt:
//   DR 1360 Inventory-Parts / CR 2050 GR/IR). This bill CLEARS 2050 — it does
// NOT re-debit 1360 (no double count). Any difference between the bill and the
// received value is a price variance booked to 6320 PO Variance.
//   DR 2050 GR/IR   = received value   ·   DR/CR 6320 PPV   ·   CR AP = bill total
//
// Body: { total_cents (required — the vendor's bill), invoice_number?, invoice_date?, ap_account_id? }
// Idempotent: a PO whose part bill is already matched (part_bill_invoice_id set)
// returns that match instead of billing twice.

import { createClient } from "@supabase/supabase-js";
import { postEvent } from "../../../_lib/accounting/posting/index.js";

export const config = { maxDuration: 30 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveEntity(admin) {
  const { data } = await admin.from("entities").select("id, default_ap_account_id").eq("code", "ROF").maybeSingle();
  return data || null;
}
async function accountByCode(admin, entityId, code) {
  const { data } = await admin.from("gl_accounts").select("id, is_postable, status").eq("entity_id", entityId).eq("code", code).maybeSingle();
  return data && data.is_postable && data.status === "active" ? data : null;
}
function centsToDecimal(c) {
  const n = BigInt(Math.trunc(Number(c))); const neg = n < 0n; const a = neg ? -n : n;
  return `${neg ? "-" : ""}${(a / 100n).toString()}.${(a % 100n).toString().padStart(2, "0")}`;
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const id = params?.id || req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};
  const totalCents = typeof body.total_cents === "number" ? body.total_cents : parseInt(body.total_cents, 10);
  if (!Number.isInteger(totalCents) || totalCents < 0) return res.status(400).json({ error: "total_cents must be a non-negative integer (the vendor's bill total)" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const { data: po } = await admin.from("purchase_orders").select("*").eq("id", id).maybeSingle();
  if (!po) return res.status(404).json({ error: "Purchase order not found" });
  if (po.part_bill_invoice_id) {
    return res.status(200).json({ purchase_order_id: id, invoice_id: po.part_bill_invoice_id, already_matched: true, message: "Part vendor bill already matched for this PO." });
  }
  if (po.po_type !== "manufacturing_part") return res.status(409).json({ error: "This endpoint bills 'manufacturing_part' POs only." });
  if (!po.vendor_id) return res.status(400).json({ error: "PO has no vendor." });

  // Received value = Σ(qty_accepted × unit cost) over this PO's POSTED receipts —
  // exactly what was credited to 2050 GR/IR at receipt.
  const { data: rcpts } = await admin.from("tanda_po_receipts").select("id").eq("purchase_order_id", id).eq("status", "posted");
  const rcptIds = (rcpts || []).map((r) => r.id);
  if (!rcptIds.length) return res.status(409).json({ error: "No posted receipts for this PO — receive the parts before billing." });
  const { data: rlines } = await admin.from("tanda_po_receipt_lines").select("qty_accepted, unit_cost_cents").in("receipt_id", rcptIds);
  const receivedCents = Math.round((rlines || []).reduce((s, l) => s + Number(l.qty_accepted || 0) * Number(l.unit_cost_cents || 0), 0));
  if (receivedCents <= 0) return res.status(409).json({ error: "Received value is 0 — nothing to bill." });

  const grir = await accountByCode(admin, entity.id, "2050");
  if (!grir) return res.status(400).json({ error: "GR/IR Clearing account (2050) not found." });
  const variance = totalCents !== receivedCents ? await accountByCode(admin, entity.id, "6320") : null;
  if (totalCents !== receivedCents && !variance) return res.status(400).json({ error: "PO Variance account (6320) not found — required when the bill differs from the received value." });

  let apAccountId = null;
  if (body.ap_account_id && UUID_RE.test(String(body.ap_account_id))) {
    const { data } = await admin.from("gl_accounts").select("id, is_postable, status").eq("id", body.ap_account_id).maybeSingle();
    if (data && data.is_postable && data.status === "active") apAccountId = data.id;
  }
  if (!apAccountId) apAccountId = entity.default_ap_account_id || (await accountByCode(admin, entity.id, "2000"))?.id || (await accountByCode(admin, entity.id, "2010"))?.id || null;
  if (!apAccountId) return res.status(400).json({ error: "No AP control account (2000/2010) configured." });

  const postingDate = body.invoice_date ? String(body.invoice_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const invoiceNumber = body.invoice_number ? String(body.invoice_number).trim() : `POB-${po.po_number || String(id).slice(0, 8)}`;

  const { data: header, error: hErr } = await admin.from("invoices").insert({
    entity_id: entity.id, vendor_id: po.vendor_id, invoice_number: invoiceNumber,
    invoice_kind: "vendor_bill", gl_status: "draft", posting_date: postingDate, due_date: postingDate,
    description: `Manufacturing-part PO ${po.po_number || id}`, ap_account_id: apAccountId, source: "manual",
  }).select().single();
  if (hErr) {
    if (hErr.code === "23505") return res.status(409).json({ error: "An invoice with that number already exists for this vendor." });
    return res.status(500).json({ error: hErr.message });
  }

  let postResult;
  try {
    postResult = await postEvent(admin, {
      kind: "ap_invoice_grir_match", entity_id: entity.id, created_by_user_id: null,
      reason: `Part PO vendor bill ${invoiceNumber} (3-way match, PO ${po.po_number || id})`,
      data: {
        invoice_id: header.id, vendor_id: po.vendor_id, invoice_number: invoiceNumber, invoice_date: postingDate,
        ap_account_id: apAccountId, grir_account_id: grir.id, variance_account_id: variance ? variance.id : null,
        received_amount: centsToDecimal(receivedCents), total_amount: centsToDecimal(totalCents),
      },
    });
  } catch (err) {
    await admin.from("invoices").delete().eq("id", header.id);
    return res.status(400).json({ error: err?.message || String(err), code: err?.code || "post_failed", details: err?.details || null });
  }

  const jeId = postResult.accrual_je_id || null;
  await admin.from("invoices").update({ accrual_je_id: jeId, gl_status: "posted" }).eq("id", header.id);
  await admin.from("purchase_orders").update({ part_bill_invoice_id: header.id, updated_at: new Date().toISOString() }).eq("id", id);

  const varianceCents = totalCents - receivedCents;
  return res.status(201).json({
    purchase_order_id: id, invoice_id: header.id, invoice_number: invoiceNumber, gl_status: "posted",
    received_cents: receivedCents, total_cents: totalCents, variance_cents: varianceCents, accrual_je_id: jeId,
    message: `Part bill ${invoiceNumber} matched — cleared $${(receivedCents / 100).toFixed(2)} GR/IR${varianceCents !== 0 ? `, ${varianceCents > 0 ? "+" : ""}$${(varianceCents / 100).toFixed(2)} to PO Variance` : ""}.`,
  });
}
