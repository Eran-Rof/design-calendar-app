// api/internal/procurement/qc/dispositions  (h600)
//
// P13 GL Chunk 3 — act on a QC failure with its GL effect.
//
// GET  ?inspection_id=  → dispositions for an inspection (newest first).
// POST { inspection_id, disposition, qty, reason, receipt_line_id?, item_id?,
//        rework_location_id? }
//   write_off          → inventory_adjustments(write_off, −qty) + post
//                        (DR 6420 Inventory Write-off / CR Inventory, FIFO).
//   vendor_credit_only → FIFO-consume the units, create a vendor_credit_memo
//                        invoice, post (DR AP vendor / CR Inventory) at FIFO cost.
//   vendor_rma         → record only (no GL; the vendor RMA is settled later).
//   rework_inhouse     → record + optional rework location (no GL value change).
//
// Service-role writes; anon-read RLS. Mirrors receipts/post.js conventions.

import { createClient } from "@supabase/supabase-js";
import { postEvent } from "../../../../_lib/accounting/posting/index.js";
import { consume as fifoConsume } from "../../../../_lib/inventory/fifo.js";
import { resolveInventoryAccount } from "../../inventory-adjustments/post.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPOSITIONS = ["write_off", "vendor_credit_only", "vendor_rma", "rework_inhouse"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
function centsToStr(cents) {
  const n = BigInt(Math.trunc(Number(cents)));
  const neg = n < 0n; const abs = neg ? -n : n;
  return `${neg ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}
async function findPostableAccount(admin, entityId, code) {
  const { data } = await admin.from("gl_accounts")
    .select("id, is_postable, status").eq("entity_id", entityId).eq("code", code).maybeSingle();
  return (data && data.is_postable && data.status === "active") ? data.id : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const inspectionId = (url.searchParams.get("inspection_id") || "").trim();
    if (!inspectionId || !UUID_RE.test(inspectionId)) return res.status(400).json({ error: "inspection_id (uuid) required" });
    const { data, error } = await admin.from("tanda_po_qc_dispositions")
      .select("*").eq("inspection_id", inspectionId).order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed" }); }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};

  const inspectionId = body.inspection_id;
  if (!inspectionId || !UUID_RE.test(String(inspectionId))) return res.status(400).json({ error: "inspection_id (uuid) required" });
  const disposition = String(body.disposition || "");
  if (!DISPOSITIONS.includes(disposition)) return res.status(400).json({ error: `disposition must be one of ${DISPOSITIONS.join(", ")}` });
  const qty = Math.round(Number(body.qty));
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: "qty must be a positive integer" });
  const reason = body.reason ? String(body.reason).trim() : "";
  if (!reason) return res.status(400).json({ error: "reason is required" });

  // Load inspection + its receipt + (optional) receipt line for item + cost.
  const { data: insp } = await admin.from("tanda_po_qc_inspections").select("*").eq("id", inspectionId).maybeSingle();
  if (!insp) return res.status(404).json({ error: "Inspection not found" });
  const entityId = insp.entity_id;
  const { data: rcpt } = await admin.from("tanda_po_receipts").select("id, purchase_order_id, receipt_date").eq("id", insp.receipt_id).maybeSingle();

  let itemId = body.item_id && UUID_RE.test(String(body.item_id)) ? body.item_id : null;
  let unitCostCents = null;
  let receiptLineId = body.receipt_line_id && UUID_RE.test(String(body.receipt_line_id)) ? body.receipt_line_id : null;
  if (receiptLineId) {
    const { data: rl } = await admin.from("tanda_po_receipt_lines")
      .select("id, receipt_id, purchase_order_line_id, unit_cost_cents, landed_unit_cost_cents").eq("id", receiptLineId).maybeSingle();
    if (!rl || rl.receipt_id !== insp.receipt_id) return res.status(400).json({ error: "receipt_line_id does not belong to this inspection's receipt" });
    unitCostCents = rl.landed_unit_cost_cents != null ? Number(rl.landed_unit_cost_cents) : Number(rl.unit_cost_cents || 0);
    if (!itemId && rl.purchase_order_line_id) {
      const { data: pol } = await admin.from("purchase_order_lines").select("inventory_item_id").eq("id", rl.purchase_order_line_id).maybeSingle();
      itemId = pol ? pol.inventory_item_id : null;
    }
  }
  if (!itemId) return res.status(400).json({ error: "item_id (or a receipt_line_id that resolves one) is required for a disposition." });
  const postingDate = rcpt?.receipt_date || new Date().toISOString().slice(0, 10);

  // Insert the disposition row first so GL side-effects can reference its id.
  const { data: disp, error: dErr } = await admin.from("tanda_po_qc_dispositions").insert({
    entity_id: entityId, inspection_id: inspectionId, receipt_line_id: receiptLineId, item_id: itemId,
    disposition, qty, unit_cost_cents: unitCostCents, reason,
    rework_location_id: (body.rework_location_id && UUID_RE.test(String(body.rework_location_id))) ? body.rework_location_id : null,
    status: (disposition === "vendor_rma" || disposition === "rework_inhouse") ? "recorded" : "posted",
  }).select("id").single();
  if (dErr) return res.status(500).json({ error: dErr.message });
  const dispId = disp.id;

  try {
    if (disposition === "write_off") {
      const inventoryAcctId = (await resolveInventoryAccount(admin, entityId, null))?.id || null;
      const writeOffAcctId = await findPostableAccount(admin, entityId, "6420");
      if (!inventoryAcctId || !writeOffAcctId) throw new Error("Need postable Inventory + Inventory Write-off (6420) accounts.");
      const { data: adj, error: aErr } = await admin.from("inventory_adjustments").insert({
        entity_id: entityId, item_id: itemId, adjustment_type: "write_off",
        qty_delta: -qty, unit_cost_cents: null, reason: `QC write-off: ${reason}`, gl_account_id: writeOffAcctId,
      }).select("id").single();
      if (aErr) throw new Error(`adjustment insert failed: ${aErr.message}`);
      const result = await postEvent(admin, {
        kind: "inventory_adjustment", entity_id: entityId, created_by_user_id: null,
        reason: `QC write-off: ${reason}`,
        data: { adjustment_id: adj.id, item_id: itemId, adjustment_type: "write_off", qty_delta: -qty,
          inventory_account_id: inventoryAcctId, gl_account_id: writeOffAcctId, posting_date: postingDate, reason: `QC write-off: ${reason}` },
      });
      await admin.from("inventory_adjustments").update({ posted_je_id: result.accrual_je_id, posted_at: new Date().toISOString() }).eq("id", adj.id);
      await admin.from("tanda_po_qc_dispositions").update({ adjustment_id: adj.id, je_id: result.accrual_je_id }).eq("id", dispId);

    } else if (disposition === "vendor_credit_only") {
      const { data: po } = rcpt?.purchase_order_id
        ? await admin.from("purchase_orders").select("vendor_id").eq("id", rcpt.purchase_order_id).maybeSingle() : { data: null };
      const vendorId = po?.vendor_id || null;
      if (!vendorId) throw new Error("Cannot resolve the vendor for a vendor credit (receipt has no native PO vendor).");
      const inventoryAcctId = (await resolveInventoryAccount(admin, entityId, null))?.id || null;
      const { data: ent } = await admin.from("entities").select("default_ap_account_id").eq("id", entityId).maybeSingle();
      const apAccountId = (ent && ent.default_ap_account_id) || (await findPostableAccount(admin, entityId, "2010"));
      if (!inventoryAcctId || !apAccountId) throw new Error("Need postable Inventory + AP (2010) accounts for a vendor credit.");

      // FIFO-consume the credited units → cost basis for the credit.
      const { cogs_cents } = await fifoConsume(admin, {
        entity_id: entityId, item_id: itemId, qty, consumer_kind: "write_off", consumer_ref_id: dispId,
      });
      const amountCents = Number(cogs_cents);
      if (amountCents <= 0) throw new Error("FIFO consume returned zero cost — nothing to credit.");

      const invNo = `QCCR-${String(dispId).slice(0, 8)}`;
      const { data: credInv, error: cErr } = await admin.from("invoices").insert({
        entity_id: entityId, vendor_id: vendorId, invoice_number: invNo, invoice_kind: "vendor_credit_memo",
        gl_status: "unposted", posting_date: postingDate, due_date: postingDate, ap_account_id: apAccountId,
        source: "system", description: `QC vendor credit — ${reason}`,
      }).select("id").single();
      if (cErr) throw new Error(`credit memo insert failed: ${cErr.message}`);
      await admin.from("invoice_line_items").insert({
        invoice_id: credInv.id, entity_id: entityId, line_index: 1, description: `QC vendor credit (${qty} units)`,
        expense_account_id: inventoryAcctId, quantity: 1, unit_cost_cents: amountCents, tax_amount_cents: 0,
      });
      const result = await postEvent(admin, {
        kind: "qc_vendor_credit", entity_id: entityId, created_by_user_id: null,
        reason: `QC vendor credit: ${reason}`,
        data: { invoice_id: credInv.id, vendor_id: vendorId, item_id: itemId, amount: centsToStr(amountCents),
          ap_account_id: apAccountId, inventory_account_id: inventoryAcctId, posting_date: postingDate, memo: `QC vendor credit ${invNo}` },
      });
      await admin.from("invoices").update({ gl_status: "posted" }).eq("id", credInv.id);
      await admin.from("tanda_po_qc_dispositions").update({ credit_invoice_id: credInv.id, je_id: result.accrual_je_id }).eq("id", dispId);

    }
    // vendor_rma + rework_inhouse: record only — no GL (status already 'recorded').
  } catch (e) {
    // Roll the disposition row back so a failed GL effect doesn't strand it.
    await admin.from("tanda_po_qc_dispositions").delete().eq("id", dispId);
    return res.status(500).json({ error: `Disposition GL failed: ${e instanceof Error ? e.message : String(e)}` });
  }

  const { data: fresh } = await admin.from("tanda_po_qc_dispositions").select("*").eq("id", dispId).single();
  return res.status(201).json(fresh);
}
