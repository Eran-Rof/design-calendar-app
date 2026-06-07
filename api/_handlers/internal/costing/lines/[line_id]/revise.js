// api/internal/costing/lines/:line_id/revise
//
// POST → operator has edited a sent/quoted costing line and confirmed they
// want to notify the vendor of the revision. This endpoint:
//   1. Sets costing_lines.status = 'revised' (displays as "Rvsd RFQ")
//   2. Finds every RFQ that contains this line (via rfq_line_items.costing_line_id)
//   3. For each RFQ, sends an rfq_revised notification to every invited vendor
//      so they know to review the updated line items. Their original quote is
//      preserved — this is advisory only, not a re-invite.
//
// The vendor's existing rfq_invitations row stays as-is; they keep portal
// access to the original RFQ and can compare against the updated costing data.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 30 };

function getLineId(req) {
  if (req.query && req.query.line_id) return req.query.line_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("lines");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const lineId = getLineId(req);
  if (!lineId) return res.status(400).json({ error: "Missing line id" });

  // 1. Mark the line revised.
  const { data: line, error: lineErr } = await admin
    .from("costing_lines")
    .update({ status: "revised", updated_at: new Date().toISOString() })
    .eq("id", lineId)
    .select("id, status, project_id, style_code, color")
    .maybeSingle();
  if (lineErr) return res.status(500).json({ error: lineErr.message });
  if (!line) return res.status(404).json({ error: "Line not found" });

  // 2. Find RFQs that contain this line (via rfq_line_items.costing_line_id FK).
  const { data: rfqItems } = await admin
    .from("rfq_line_items")
    .select("rfq_id")
    .eq("costing_line_id", lineId);

  const rfqIds = [...new Set((rfqItems || []).map((r) => r.rfq_id).filter(Boolean))];

  const origin = `https://${req.headers.host}`;
  let notified = 0;

  // 3. For each RFQ, look up its title + invited vendors and send rfq_revised.
  for (const rfqId of rfqIds) {
    const [{ data: rfq }, { data: invitations }] = await Promise.all([
      admin.from("rfqs").select("id, title").eq("id", rfqId).maybeSingle(),
      admin.from("rfq_invitations").select("vendor_id").eq("rfq_id", rfqId),
    ]);
    if (!rfq) continue;

    for (const inv of invitations || []) {
      try {
        await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "rfq_revised",
            title: `Revised RFQ: ${rfq.title}`,
            body: `Ring of Fire has updated the line items on RFQ "${rfq.title}". Your original quote is preserved — please review the revision and update your quote if needed.`,
            link: "/vendor/rfqs",
            metadata: { rfq_id: rfqId, vendor_id: inv.vendor_id, costing_line_id: lineId },
            recipient: { vendor_id: inv.vendor_id },
            dedupe_key: `rfq_revised_${rfqId}_${inv.vendor_id}_${lineId}_${Date.now()}`,
            email: true,
          }),
        }).catch(() => {});
        notified++;
      } catch { /* swallow; notification failure must not block status update */ }
    }
  }

  return res.status(200).json({
    ok: true,
    revised_line_id: lineId,
    rfqs_notified: rfqIds.length,
    vendors_notified: notified,
  });
}
