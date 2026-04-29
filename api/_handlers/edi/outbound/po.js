// api/edi/outbound/po
//
// POST — build and store an outbound 850 for a specific PO.
//   body: { po_id? or po_number?, vendor_id? }
// Called by internal workflow when PO status transitions to 'issued'.
//
// The 850 envelope is stored in edi_messages (direction='outbound',
// status='received'). Actual AS2/SFTP delivery to the partner is
// expected to happen via a separate delivery worker (which reads
// pending outbound 850/820 rows and ships them) — this endpoint only
// prepares the message.

import { createClient } from "@supabase/supabase-js";
import { build850 } from "../../../_lib/edi/builder.js";

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
  const { po_id, po_number } = body || {};

  let poQuery = admin.from("tanda_pos").select("uuid_id, po_number, vendor_id, data");
  if (po_id)           poQuery = poQuery.eq("uuid_id", po_id);
  else if (po_number)  poQuery = poQuery.eq("po_number", po_number);
  else return res.status(400).json({ error: "po_id or po_number is required" });

  const { data: po } = await poQuery.maybeSingle();
  if (!po) return res.status(404).json({ error: "PO not found" });

  const { data: integration } = await admin
    .from("erp_integrations")
    .select("id, config, status")
    .eq("vendor_id", po.vendor_id)
    .eq("status", "active")
    .maybeSingle();
  const partnerId = integration?.config?.partner_id || integration?.config?.edi_id || null;
  if (!partnerId) return res.status(400).json({ error: "No active ERP integration with partner_id for this vendor" });

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

  const envelope = build850({
    sender:   "RINGOFFIRE",
    receiver: partnerId,
    controlNumber: Math.floor(Date.now() / 1000) % 1_000_000_000,
    po: {
      po_number: po.po_number,
      order_date: po.data?.DateOrder || new Date(),
      currency:   po.data?.Currency || "USD",
      buyer:      po.data?.BuyerName || "ROF",
      line_items,
    },
  });

  const { data: msg, error } = await admin.from("edi_messages").insert({
    vendor_id: po.vendor_id,
    direction: "outbound",
    transaction_set: "850",
    interchange_id: null,
    status: "received",
    raw_content: envelope,
  }).select("id").single();
  if (error) return res.status(500).json({ error: error.message });

  if (integration) {
    await admin.from("erp_sync_logs").insert({
      integration_id: integration.id,
      direction: "outbound",
      entity_type: "po",
      entity_id: po.uuid_id,
      status: "success",
      payload_hash: `850-${po.po_number}-${Date.now()}`,
    });
  }

  return res.status(201).json({ edi_message_id: msg.id, transaction_set: "850", po_number: po.po_number });
}
