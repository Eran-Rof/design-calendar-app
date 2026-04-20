// api/internal/edi/:vendor_id/send
//
// POST — manually trigger an outbound EDI transaction. Useful for
// resending failed transmissions or sending ad-hoc.
//   body: {
//     transaction_set: "850" | "820" | "997",
//     entity_id?: uuid         // required for 850 (po_id)
//     invoice_ids?: [uuid]     // required for 820
//     payment_ref?: string     // optional for 820
//     payer_name?: string      // optional for 820
//     interchange_id?: string  // required for 997 (AK1 reference)
//     group_fn_id?: string     // required for 997
//     group_control?: string   // required for 997
//     accepted?: boolean       // optional for 997, default true
//   }
//
// Dispatches to the existing builders. Stores the envelope in
// edi_messages (direction=outbound) and logs to erp_sync_logs.

import { createClient } from "@supabase/supabase-js";
import { build850, build820, build997 } from "../../../../_lib/edi/builder.js";

export const config = { maxDuration: 30 };

function getVendorId(req) {
  if (req.query && req.query.vendor_id) return req.query.vendor_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("edi");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const vendorId = getVendorId(req);
  if (!vendorId) return res.status(400).json({ error: "Missing vendor id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { transaction_set, entity_id, invoice_ids, payment_ref, payer_name, interchange_id, group_fn_id, group_control, accepted } = body || {};
  if (!["850", "820", "997"].includes(transaction_set))
    return res.status(400).json({ error: "transaction_set must be 850, 820, or 997" });

  const [{ data: vendor }, { data: integration }] = await Promise.all([
    admin.from("vendors").select("id, name").eq("id", vendorId).maybeSingle(),
    admin.from("erp_integrations").select("id, config, status").eq("vendor_id", vendorId).eq("status", "active").maybeSingle(),
  ]);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  const partnerId = integration?.config?.partner_id || integration?.config?.edi_id || null;
  if (!partnerId) return res.status(400).json({ error: "No active ERP integration with partner_id for this vendor" });

  const controlNumber = Math.floor(Date.now() / 1000) % 1_000_000_000;
  let envelope = "";
  let entityTypeForLog = "po";
  let loggedEntityId = null;

  if (transaction_set === "850") {
    if (!entity_id) return res.status(400).json({ error: "entity_id (po_id) is required for 850" });
    const { data: po } = await admin.from("tanda_pos").select("uuid_id, po_number, data").eq("uuid_id", entity_id).eq("vendor_id", vendorId).maybeSingle();
    if (!po) return res.status(404).json({ error: "PO not found for this vendor" });

    const items = Array.isArray(po.data?.Items) ? po.data.Items
                : Array.isArray(po.data?.PoLineArr) ? po.data.PoLineArr
                : [];
    const line_items = items.map((it, i) => ({
      line: i + 1,
      sku: it.ItemNumber || it.SKU || it.sku || "",
      qty: Number(it.QtyOrder) || Number(it.quantity) || 0,
      unit: "EA",
      price: Number(it.UnitPrice || it.Price || 0),
      description: it.Description || it.ItemName || "",
    }));

    envelope = build850({
      sender: "RINGOFFIRE", receiver: partnerId, controlNumber,
      po: {
        po_number: po.po_number,
        order_date: po.data?.DateOrder || new Date(),
        currency: po.data?.Currency || "USD",
        buyer: po.data?.BuyerName || "ROF",
        line_items,
      },
    });
    entityTypeForLog = "po";
    loggedEntityId = po.uuid_id;
  } else if (transaction_set === "820") {
    if (!Array.isArray(invoice_ids) || invoice_ids.length === 0)
      return res.status(400).json({ error: "invoice_ids must be a non-empty array for 820" });

    const { data: invoices } = await admin.from("invoices").select("id, invoice_number, total, currency").eq("vendor_id", vendorId).in("id", invoice_ids);
    if (!invoices || invoices.length === 0) return res.status(404).json({ error: "No matching invoices" });
    const totalAmount = invoices.reduce((sum, i) => sum + (Number(i.total) || 0), 0);
    envelope = build820({
      sender: "RINGOFFIRE", receiver: partnerId, controlNumber,
      payment: {
        amount: totalAmount, currency: invoices[0]?.currency || "USD",
        effective_date: new Date(),
        payer_name: payer_name || "Ring of Fire",
        payee_name: vendor.name,
        payment_ref: payment_ref || `ROF-${Date.now()}`,
        invoices: invoices.map((i) => ({ invoice_number: i.invoice_number, amount: Number(i.total) || 0 })),
      },
    });
    entityTypeForLog = "payment";
    loggedEntityId = null;
  } else { // 997
    if (!interchange_id || !group_fn_id || !group_control)
      return res.status(400).json({ error: "interchange_id, group_fn_id, and group_control are required for 997" });
    envelope = build997({
      sender: "RINGOFFIRE", receiver: partnerId, controlNumber,
      ackForGroup: { functionalId: group_fn_id, controlNumber: group_control },
      ackForControl: interchange_id,
      accepted: accepted !== false,
    });
    entityTypeForLog = "po";
    loggedEntityId = null;
  }

  const { data: msg, error } = await admin.from("edi_messages").insert({
    vendor_id: vendorId,
    direction: "outbound",
    transaction_set,
    interchange_id: interchange_id || null,
    status: "received",
    raw_content: envelope,
  }).select("id").single();
  if (error) return res.status(500).json({ error: error.message });

  if (integration) {
    await admin.from("erp_sync_logs").insert({
      integration_id: integration.id,
      direction: "outbound",
      entity_type: entityTypeForLog,
      entity_id: loggedEntityId,
      status: "success",
      payload_hash: `${transaction_set}-${controlNumber}`,
    });
  }

  return res.status(201).json({ edi_message_id: msg.id, transaction_set, control_number: controlNumber });
}
