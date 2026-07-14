// api/internal/edi-messages/:id
//
//   GET  → full EDI message detail incl. raw_content + parsed_content + the
//          outbox/inbox state (attempts, last_error, ack_status, transport).
//   POST { action: "retry" } → requeue a failed OUTBOUND message for the next
//          transport-cron pass (status → queued, backoff gate cleared). Attempts
//          are preserved for the audit trail.

import { createClient } from "@supabase/supabase-js";
import { requeueForRetry } from "../../../_lib/edi/outbox.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const id = getId(req);
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("edi_messages")
      .select("id, vendor_id, direction, transaction_set, interchange_id, group_control_number, status, attempts, last_error, error_message, transmitted, transport_detail, ack_status, acked_at, file_name, next_attempt_at, raw_content, parsed_content, tpl_provider_id, tpl_shipment_id, edi_customer_partner_id, ar_invoice_id, sales_order_id, created_at, updated_at, vendors(name, code), tpl_providers(name, code), edi_customer_partners(customers(name, customer_code))")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Message not found" });
    const message = {
      ...data,
      vendor_name: data.vendors?.name || null,
      tpl_provider_name: data.tpl_providers?.name || null,
      customer_name: data.edi_customer_partners?.customers?.name || null,
    };
    delete message.vendors; delete message.tpl_providers; delete message.edi_customer_partners;
    return res.status(200).json({ message });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    if (body.action !== "retry") return res.status(400).json({ error: "Unsupported action" });

    const { data: msg } = await admin.from("edi_messages").select("id, direction, status").eq("id", id).maybeSingle();
    if (!msg) return res.status(404).json({ error: "Message not found" });
    if (msg.direction !== "outbound") return res.status(409).json({ error: "Only outbound messages can be retried" });
    if (!["failed", "queued", "generated"].includes(msg.status)) {
      return res.status(409).json({ error: `Cannot retry a '${msg.status}' message` });
    }
    const { error } = await admin.from("edi_messages").update(requeueForRetry()).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, message: "Message re-queued — it will be sent on the next transport pass." });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
