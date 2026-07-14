// api/internal/edi-messages  (h621)
//
// P22 / M14 — global EDI message log (surfaces the existing `edi_messages`
// engine output across all vendors). The per-vendor history already exists at
// /api/internal/edi/:vendor_id/messages; this is the dashboard-wide view.
//
//   GET /api/internal/edi-messages
//       ?direction=inbound|outbound &transaction_set=850|855|856|810|820|997
//       &status=... &vendor_id=<uuid> &limit=200
//
// raw_content is omitted from the list (large); parsed_content summary kept.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const direction = (url.searchParams.get("direction") || "").trim();
  const txn = (url.searchParams.get("transaction_set") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const vendorId = (url.searchParams.get("vendor_id") || "").trim();
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10) || 200));

  const providerId = (url.searchParams.get("tpl_provider_id") || "").trim();

  let q = admin
    .from("edi_messages")
    .select("id, vendor_id, direction, transaction_set, interchange_id, status, attempts, last_error, error_message, transmitted, ack_status, file_name, tpl_provider_id, tpl_shipment_id, created_at, vendors(name, code), tpl_providers(name, code)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (direction) q = q.eq("direction", direction);
  if (txn) q = q.eq("transaction_set", txn);
  if (status) q = q.eq("status", status);
  if (vendorId) q = q.eq("vendor_id", vendorId);
  if (providerId) q = q.eq("tpl_provider_id", providerId);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const messages = (data || []).map((m) => ({
    id: m.id, vendor_id: m.vendor_id, vendor_name: m.vendors?.name || null,
    tpl_provider_id: m.tpl_provider_id, tpl_provider_name: m.tpl_providers?.name || null,
    direction: m.direction, transaction_set: m.transaction_set, interchange_id: m.interchange_id,
    status: m.status, attempts: m.attempts, transmitted: m.transmitted, ack_status: m.ack_status,
    file_name: m.file_name, error_message: m.error_message || m.last_error, created_at: m.created_at,
  }));
  return res.status(200).json({ messages });
}
