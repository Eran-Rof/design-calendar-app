// api/internal/sustainability/:id/review
//
// PUT — approve or reject a sustainability report.
//   body: { status: 'approved' | 'rejected', notes?, reviewer? }
//   On 'approved' → triggers ESG score calculation.
//   On either → sends sustainability_reviewed notification to the vendor.

import { createClient } from "@supabase/supabase-js";
import { generateEsgScoreForReport } from "../../../../_lib/esg.js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 30 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("review");
  return idx > 0 ? parts[idx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing report id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { status, notes, reviewer } = body || {};
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "status must be approved|rejected" });

  const { data: report } = await admin.from("sustainability_reports").select("*").eq("id", id).maybeSingle();
  if (!report) return res.status(404).json({ error: "Report not found" });

  const nowIso = new Date().toISOString();
  const updates = {
    status, reviewed_by: reviewer || "internal", reviewed_at: nowIso, updated_at: nowIso,
    ...(status === "rejected" ? { rejection_reason: notes || null } : {}),
  };
  const { error } = await admin.from("sustainability_reports").update(updates).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });

  let esgResult = null;
  if (status === "approved") {
    try {
      esgResult = await generateEsgScoreForReport(admin, { ...report, ...updates });
    } catch (err) {
      // Non-fatal: score can be regenerated; report stays approved
      esgResult = { error: err?.message || String(err) };
    }
  }

  // Vendor notification
  try {
    const origin = `https://${req.headers.host}`;
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "sustainability_reviewed",
        title: `Sustainability report ${status === "approved" ? "approved" : "requires updates"}: ${report.reporting_period_start} → ${report.reporting_period_end}`,
        body: status === "approved"
          ? `Your ${report.reporting_period_start} → ${report.reporting_period_end} sustainability report was approved.`
          : `Your ${report.reporting_period_start} → ${report.reporting_period_end} report was rejected.${notes ? "\n\nReason: " + notes : ""}`,
        link: "/vendor/sustainability",
        metadata: { report_id: id, status, notes: notes || null, esg_score_id: esgResult?.esg_score_id || null },
        recipient: { vendor_id: report.vendor_id },
        dedupe_key: `sustainability_reviewed_${id}_${status}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(200).json({ ok: true, id, status, esg: esgResult });
}
