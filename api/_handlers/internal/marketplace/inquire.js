// api/internal/marketplace/inquire
//
// POST — internal user sends an inquiry about a published listing.
//   body: { listing_id, entity_id, message, inquired_by }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { listing_id, message, inquired_by } = body || {};
  const entity_id = body?.entity_id || req.headers["x-entity-id"];
  if (!listing_id || !message || !inquired_by || !entity_id) {
    return res.status(400).json({ error: "listing_id, entity_id, message, and inquired_by are required" });
  }

  const { data: listing } = await admin.from("marketplace_listings")
    .select("id, vendor_id, title, status").eq("id", listing_id).maybeSingle();
  if (!listing) return res.status(404).json({ error: "Listing not found" });
  if (listing.status !== "published") return res.status(409).json({ error: "Listing is not published" });

  const { data: inquiry, error } = await admin.from("marketplace_inquiries").insert({
    listing_id, entity_id, inquired_by, message: String(message).trim(),
  }).select("*").single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify the vendor
  try {
    const origin = `https://${req.headers.host}`;
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "marketplace_inquiry_received",
        title: "New inquiry about your marketplace listing",
        body: `A buyer is asking about your listing "${listing.title}". Open the vendor portal to respond.`,
        link: "/vendor/marketplace/inquiries",
        metadata: { inquiry_id: inquiry.id, listing_id },
        recipient: { vendor_id: listing.vendor_id },
        dedupe_key: `inquiry_received_${inquiry.id}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(201).json(inquiry);
}
