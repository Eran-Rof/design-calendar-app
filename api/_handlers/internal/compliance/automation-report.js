// api/internal/compliance/automation-report
//
// GET — summary: requests sent this month, renewals completed, escalations open,
//       plus per-document-type breakdown.
//   ?from=<ISO>&to=<ISO>  — default: first of this month → now

import { createClient } from "@supabase/supabase-js";
import { automationSummary } from "../../../_lib/compliance-audit.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  let from = url.searchParams.get("from");
  let to   = url.searchParams.get("to");
  if (!from) {
    const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
    from = d.toISOString();
  }
  if (!to) to = new Date().toISOString();

  const summary = await automationSummary(admin, { from_iso: from, to_iso: to });

  // Add type names to the breakdown
  const typeIds = Object.keys(summary.by_document_type);
  if (typeIds.length) {
    const { data: types } = await admin.from("compliance_document_types").select("id, name, code").in("id", typeIds);
    const typeMap = {};
    for (const t of types || []) typeMap[t.id] = t;
    summary.by_document_type = Object.fromEntries(
      Object.entries(summary.by_document_type).map(([id, stats]) => [
        id, { ...stats, name: typeMap[id]?.name || id, code: typeMap[id]?.code || null },
      ])
    );
  }

  return res.status(200).json({ range: { from, to }, ...summary });
}
