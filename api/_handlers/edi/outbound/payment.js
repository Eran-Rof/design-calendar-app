// api/edi/outbound/payment
//
// POST — build and store an outbound 820 for a paid invoice or batch
// of paid invoices.
//   body: { vendor_id, invoice_ids: [uuid, ...], payment_ref? }
// Called by internal workflow when payment status → 'sent'.
//
// Auth: requires the EDI shared secret (X-EDI-Token). Previously
// unauthenticated, which let any HTTP caller mint outbound 820
// envelopes against any vendor's invoices. Same secret is used by
// the inbound endpoint.

import { createClient } from "@supabase/supabase-js";
import { build820 } from "../../../_lib/edi/builder.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-EDI-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Fail closed on missing secret — see edi/inbound/index.js for rationale.
  const SECRET = process.env.EDI_INBOUND_SHARED_SECRET;
  if (!SECRET) {
    return res.status(500).json({ error: "EDI_INBOUND_NOT_CONFIGURED" });
  }
  const token = req.headers["x-edi-token"];
  if (!token || token !== SECRET) {
    return res.status(401).json({ error: "Invalid EDI token" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { vendor_id, invoice_ids, payment_ref, payer_name } = body || {};
  if (!vendor_id) return res.status(400).json({ error: "vendor_id is required" });
  if (!Array.isArray(invoice_ids) || invoice_ids.length === 0) return res.status(400).json({ error: "invoice_ids must be a non-empty array" });

  const [{ data: vendor }, { data: integration }, { data: invoices }] = await Promise.all([
    admin.from("vendors").select("id, name").eq("id", vendor_id).maybeSingle(),
    admin.from("erp_integrations").select("id, config, status").eq("vendor_id", vendor_id).eq("status", "active").maybeSingle(),
    admin.from("invoices").select("id, invoice_number, total, currency, status").eq("vendor_id", vendor_id).in("id", invoice_ids),
  ]);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  if ((invoices || []).length === 0) return res.status(404).json({ error: "No matching invoices" });
  const partnerId = integration?.config?.partner_id || integration?.config?.edi_id || null;
  if (!partnerId) return res.status(400).json({ error: "No active ERP integration with partner_id for this vendor" });

  // Sum in 4-decimal-precision integer cents-equivalent (multiply by
  // 10000) so a 50-invoice batch doesn't drift through repeated float
  // adds. Round once at the end and re-emit as a decimal number for
  // the X12 builder. Each invoice's individual amount keeps its raw
  // string form so the 820 line items are exact.
  const totalAmountScaled = invoices.reduce((sum, i) => {
    const n = Number(i.total);
    return sum + (Number.isFinite(n) ? Math.round(n * 10000) : 0);
  }, 0);
  const totalAmount = totalAmountScaled / 10000;
  const envelope = build820({
    sender:   "RINGOFFIRE",
    receiver: partnerId,
    controlNumber: Math.floor(Date.now() / 1000) % 1_000_000_000,
    payment: {
      amount: totalAmount,
      currency: invoices[0]?.currency || "USD",
      effective_date: new Date(),
      payer_name: payer_name || "Ring of Fire",
      payee_name: vendor.name,
      payment_ref: payment_ref || `ROF-${Date.now()}`,
      invoices: invoices.map((i) => ({
        invoice_number: i.invoice_number,
        amount: Number.isFinite(Number(i.total)) ? Math.round(Number(i.total) * 10000) / 10000 : 0,
      })),
    },
  });

  const { data: msg, error } = await admin.from("edi_messages").insert({
    vendor_id,
    direction: "outbound",
    transaction_set: "820",
    interchange_id: null,
    status: "received",
    raw_content: envelope,
  }).select("id").single();
  if (error) return res.status(500).json({ error: error.message });

  if (integration) {
    await admin.from("erp_sync_logs").insert({
      integration_id: integration.id,
      direction: "outbound",
      entity_type: "payment",
      entity_id: null,
      status: "success",
      payload_hash: `820-${payment_ref || Date.now()}`,
    });
  }

  return res.status(201).json({ edi_message_id: msg.id, transaction_set: "820", invoices: invoices.length, total: totalAmount });
}
