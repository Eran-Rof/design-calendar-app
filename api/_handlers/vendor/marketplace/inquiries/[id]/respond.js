// api/vendor/marketplace/inquiries/:id/respond
//
// POST — vendor responds to an inquiry on their own listing.
//   body: { response }

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../../../_lib/vendor-auth.js";

export const config = { maxDuration: 15 };

function getId(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("respond");
  return idx > 0 ? parts[idx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const vendorId = authRes.auth.vendor_id;

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing inquiry id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const response = body?.response;
  if (!response || !String(response).trim()) return res.status(400).json({ error: "response required" });

  // Authorize: inquiry's listing must belong to caller, and grab vendor name for the notification subject
  const { data: inquiry } = await admin.from("marketplace_inquiries")
    .select("*, listing:marketplace_listings(id, vendor_id, title, vendor:vendors(id, name))")
    .eq("id", id).maybeSingle();
  if (!inquiry) return res.status(404).json({ error: "Inquiry not found" });
  if (inquiry.listing?.vendor_id !== vendorId) return res.status(403).json({ error: "Not your listing" });
  if (inquiry.status === "converted_to_rfq") return res.status(409).json({ error: "Inquiry already converted to RFQ" });

  const nowIso = new Date().toISOString();
  const { error } = await admin.from("marketplace_inquiries")
    .update({ response: String(response).trim(), responded_at: nowIso, status: "responded" })
    .eq("id", id);
  if (error) return res.status(500).json({ error: error.message });

  // Notify the inquiring user
  try {
    const origin = `https://${req.headers.host}`;
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "marketplace_inquiry_responded",
        title: `${inquiry.listing?.vendor?.name || "Vendor"} responded to your marketplace inquiry`,
        body: String(response).slice(0, 500),
        link: "/",
        metadata: { inquiry_id: id, listing_id: inquiry.listing_id, entity_id: inquiry.entity_id },
        recipient: { internal_id: inquiry.inquired_by, email: process.env.INTERNAL_COMPLIANCE_EMAILS || "" },
        dedupe_key: `marketplace_inquiry_responded_${id}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(200).json({ ok: true, id, status: "responded" });
}
