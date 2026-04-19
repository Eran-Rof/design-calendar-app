// api/internal/rfqs/:id/close
//
// POST — flip status → closed and notify all invited vendors so they
// know submissions are no longer accepted.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const cIdx = parts.lastIndexOf("close");
  return cIdx > 0 ? parts[cIdx - 1] : null;
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

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing rfq id" });

  const { data: rfq } = await admin.from("rfqs").select("*").eq("id", id).maybeSingle();
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  if (rfq.status === "awarded") return res.status(409).json({ error: "RFQ is already awarded — use close only before awarding" });
  if (rfq.status === "closed") return res.status(200).json({ ok: true, id, status: "closed", already: true });

  const { error } = await admin.from("rfqs").update({ status: "closed", updated_at: new Date().toISOString() }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });

  const { data: invitations } = await admin.from("rfq_invitations").select("vendor_id").eq("rfq_id", id);
  const origin = `https://${req.headers.host}`;
  for (const inv of invitations || []) {
    try {
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "rfq_closed",
          title: `RFQ closed: ${rfq.title}`,
          body: `The RFQ "${rfq.title}" is now closed. We'll reach out to the winner shortly.`,
          link: "/vendor/rfqs",
          metadata: { rfq_id: id, vendor_id: inv.vendor_id },
          recipient: { vendor_id: inv.vendor_id },
          dedupe_key: `rfq_closed_${id}_${inv.vendor_id}`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* swallow */ }
  }

  return res.status(200).json({ ok: true, id, status: "closed", notified: (invitations || []).length });
}
