// api/internal/marketplace/convert-to-rfq
//
// POST — convert an inquiry into a draft RFQ pre-filled with the listing's
//        title/description/category, and link the inquiry to the new RFQ.
//   body: { inquiry_id, created_by? }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

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

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const inquiryId = body?.inquiry_id;
  if (!inquiryId) return res.status(400).json({ error: "inquiry_id required" });

  const { data: inquiry } = await admin.from("marketplace_inquiries")
    .select("*, listing:marketplace_listings(id, title, description, category, vendor_id)")
    .eq("id", inquiryId).maybeSingle();
  if (!inquiry) return res.status(404).json({ error: "Inquiry not found" });
  if (inquiry.rfq_id) return res.status(409).json({ error: "Inquiry already converted" });

  const listing = inquiry.listing;
  if (!listing) return res.status(409).json({ error: "Linked listing no longer exists" });

  const { data: rfq, error: insErr } = await admin.from("rfqs").insert({
    entity_id: inquiry.entity_id,
    title: listing.title,
    description: listing.description ? `${listing.description}\n\n---\nInquiry message:\n${inquiry.message}` : `Inquiry message:\n${inquiry.message}`,
    category: listing.category || null,
    status: "draft",
    created_by: body?.created_by || inquiry.inquired_by,
  }).select("*").single();
  if (insErr) return res.status(500).json({ error: insErr.message });

  const { error: updErr } = await admin.from("marketplace_inquiries")
    .update({ rfq_id: rfq.id, status: "converted_to_rfq" }).eq("id", inquiryId);
  if (updErr) return res.status(500).json({ error: updErr.message });

  // Invite the originating vendor to the RFQ (if rfq_invitations exists)
  try {
    await admin.from("rfq_invitations").insert({
      rfq_id: rfq.id, vendor_id: listing.vendor_id, status: "pending",
    });
  } catch { /* non-blocking */ }

  return res.status(201).json({ rfq, inquiry_id: inquiryId });
}
