// api/internal/rfqs/:id/publish
//
// POST — flip status draft → published and send invitations to every
// invited vendor. Idempotent: re-publishing skips invitations that
// already received the rfq_invited notification (dedupe_key includes
// rfq_id + vendor_id).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const pIdx = parts.lastIndexOf("publish");
  return pIdx > 0 ? parts[pIdx - 1] : null;
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
  if (rfq.status === "awarded" || rfq.status === "closed") return res.status(409).json({ error: `Cannot publish an RFQ in status ${rfq.status}` });

  if (rfq.status !== "published") {
    const { error } = await admin.from("rfqs").update({ status: "published", updated_at: new Date().toISOString() }).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
  }

  const [{ data: invitations }, { data: lineItems }] = await Promise.all([
    admin.from("rfq_invitations").select("vendor_id").eq("rfq_id", id).eq("status", "invited"),
    admin.from("rfq_line_items").select("id").eq("rfq_id", id),
  ]);
  const origin = `https://${req.headers.host}`;
  const lineCount = (lineItems || []).length;

  for (const inv of invitations || []) {
    try {
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "rfq_invited",
          title: `New RFQ: ${rfq.title}`,
          body: `You're invited to quote on ${rfq.title}. ${lineCount} line item${lineCount === 1 ? "" : "s"}${rfq.submission_deadline ? ` · deadline ${rfq.submission_deadline.slice(0, 10)}` : ""}.`,
          link: "/vendor/rfqs",
          metadata: { rfq_id: id, vendor_id: inv.vendor_id },
          recipient: { vendor_id: inv.vendor_id },
          dedupe_key: `rfq_invited_${id}_${inv.vendor_id}`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* swallow */ }
  }

  return res.status(200).json({ ok: true, id, status: "published", notified: (invitations || []).length });
}
