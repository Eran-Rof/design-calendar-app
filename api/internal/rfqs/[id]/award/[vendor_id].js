// api/internal/rfqs/:id/award/:vendor_id
//
// POST — award the RFQ to a vendor.
// Effects (all in order):
//   1. RFQ.status = 'awarded', awarded_to_vendor_id = vendor_id, awarded_at = now
//   2. Winning quote status = 'awarded'
//   3. All other quotes status = 'rejected'
//   4. rfq_awarded notification to winner
//   5. rfq_not_awarded notification to every other quoter
//   6. Fire workflow event rfq_awarded with context

import { createClient } from "@supabase/supabase-js";
import { fireWorkflowEvent } from "../../../../_lib/workflow.js";

export const config = { maxDuration: 30 };

function getIds(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const rfqIdx = parts.lastIndexOf("rfqs");
  const awardIdx = parts.lastIndexOf("award");
  return {
    rfq_id:    rfqIdx >= 0 ? parts[rfqIdx + 1] : (req.query?.id || null),
    vendor_id: awardIdx >= 0 ? parts[awardIdx + 1] : (req.query?.vendor_id || null),
  };
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

  const { rfq_id, vendor_id } = getIds(req);
  if (!rfq_id || !vendor_id) return res.status(400).json({ error: "Missing rfq or vendor id" });

  const [{ data: rfq }, { data: vendor }] = await Promise.all([
    admin.from("rfqs").select("*").eq("id", rfq_id).maybeSingle(),
    admin.from("vendors").select("id, name").eq("id", vendor_id).maybeSingle(),
  ]);
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  if (rfq.status === "awarded") return res.status(409).json({ error: "RFQ is already awarded" });

  const nowIso = new Date().toISOString();

  // 1. Set RFQ to awarded
  await admin.from("rfqs").update({
    status: "awarded",
    awarded_to_vendor_id: vendor_id,
    awarded_at: nowIso,
    updated_at: nowIso,
  }).eq("id", rfq_id);

  // 2 & 3. Update quotes
  const { data: allQuotes } = await admin.from("rfq_quotes").select("id, vendor_id").eq("rfq_id", rfq_id);
  const winning = (allQuotes || []).find((q) => q.vendor_id === vendor_id);
  if (winning) {
    await admin.from("rfq_quotes").update({ status: "awarded", updated_at: nowIso }).eq("id", winning.id);
  }
  const losingIds = (allQuotes || []).filter((q) => q.vendor_id !== vendor_id).map((q) => q.id);
  if (losingIds.length > 0) {
    await admin.from("rfq_quotes").update({ status: "rejected", updated_at: nowIso }).in("id", losingIds);
  }

  // 4. Winner notification
  const origin = `https://${req.headers.host}`;
  try {
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "rfq_awarded",
        title: `You've been awarded the contract for ${rfq.title}`,
        body: `Congratulations — your quote on "${rfq.title}" has been awarded. We'll follow up with the next steps shortly.`,
        link: "/vendor/rfqs",
        metadata: { rfq_id, vendor_id, rfq_title: rfq.title, won: true },
        recipient: { vendor_id },
        dedupe_key: `rfq_awarded_${rfq_id}_${vendor_id}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* swallow */ }

  // 5. Loser notifications — only to vendors who actually submitted a
  // quote (not declined / still-draft), per spec.
  const losingVendors = [...new Set(
    (allQuotes || [])
      .filter((q) => q.vendor_id !== vendor_id && ["submitted", "under_review", "rejected"].includes(q.status))
      .map((q) => q.vendor_id)
  )];
  for (const vid of losingVendors) {
    try {
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "rfq_not_awarded",
          title: `Quote outcome: ${rfq.title}`,
          body: `Thank you for quoting on "${rfq.title}". The award went to another vendor this time — we appreciate your participation.`,
          link: "/vendor/rfqs",
          metadata: { rfq_id, vendor_id: vid, rfq_title: rfq.title, won: false },
          recipient: { vendor_id: vid },
          dedupe_key: `rfq_not_awarded_${rfq_id}_${vid}`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* swallow */ }
  }

  // 6. Workflow event
  try {
    await fireWorkflowEvent({
      admin, origin,
      event: "rfq_awarded",
      entity_id: rfq.entity_id,
      context: {
        entity_type: "rfq",
        entity_id: rfq_id,
        vendor_id,
        vendor_name: vendor.name,
        rfq_title: rfq.title,
        category: rfq.category,
        amount: winning ? null : null, // quote total_price can be added here via a second lookup if needed
      },
    });
  } catch { /* non-blocking */ }

  return res.status(200).json({ ok: true, rfq_id, awarded_to: vendor_id, losers_notified: losingVendors.length });
}
