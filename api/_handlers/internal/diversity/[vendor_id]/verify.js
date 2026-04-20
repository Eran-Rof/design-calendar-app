// api/internal/diversity/:vendor_id/verify
//
// PUT — mark a vendor's diversity profile as verified.
//   body: { reviewer }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getVendorId(req) {
  if (req.query && req.query.vendor_id) return req.query.vendor_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("verify");
  return idx > 0 ? parts[idx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const vendorId = getVendorId(req);
  if (!vendorId) return res.status(400).json({ error: "Missing vendor_id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const reviewer = body?.reviewer || "internal";

  const { data: profile } = await admin.from("diversity_profiles").select("id").eq("vendor_id", vendorId).maybeSingle();
  if (!profile) return res.status(404).json({ error: "No diversity profile for this vendor" });

  const nowIso = new Date().toISOString();
  const { error } = await admin.from("diversity_profiles")
    .update({ verified: true, verified_at: nowIso, verified_by: reviewer, updated_at: nowIso })
    .eq("id", profile.id);
  if (error) return res.status(500).json({ error: error.message });

  // Notify vendor
  try {
    const origin = `https://${req.headers.host}`;
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "diversity_verified",
        title: "Diversity certification verified",
        body: "Your diversity certification has been verified by the buyer's team.",
        link: "/vendor/diversity",
        metadata: { vendor_id: vendorId },
        recipient: { vendor_id: vendorId },
        dedupe_key: `diversity_verified_${vendorId}_${nowIso}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(200).json({ ok: true, vendor_id: vendorId, verified: true, verified_at: nowIso });
}
