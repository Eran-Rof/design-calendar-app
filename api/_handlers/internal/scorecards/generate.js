// api/internal/scorecards/generate.js
//
// POST — manual scorecard generation / back-fill.
//   body: { period_start: "YYYY-MM-DD",
//           period_end:   "YYYY-MM-DD",
//           vendor_id?:   uuid  // omit to run for all active vendors }
// Calls compute_vendor_scorecard() for each target vendor.
// Returns a per-vendor result list.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 300 };

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
  const { period_start, period_end, vendor_id } = body || {};
  if (!period_start || !period_end) return res.status(400).json({ error: "period_start and period_end are required (YYYY-MM-DD)" });
  if (new Date(period_end) < new Date(period_start)) return res.status(400).json({ error: "period_end must be >= period_start" });

  let targetVendors = [];
  if (vendor_id) {
    const { data: v, error } = await admin.from("vendors").select("id, name").eq("id", vendor_id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!v) return res.status(404).json({ error: "Vendor not found" });
    targetVendors = [v];
  } else {
    const { data: vs, error } = await admin.from("vendors").select("id, name").is("deleted_at", null);
    if (error) return res.status(500).json({ error: error.message });
    targetVendors = vs || [];
  }

  const results = [];
  for (const v of targetVendors) {
    try {
      const { data: scId, error: rpcErr } = await admin.rpc("compute_vendor_scorecard", {
        p_vendor_id: v.id, p_period_start: period_start, p_period_end: period_end,
      });
      if (rpcErr) { results.push({ vendor_id: v.id, name: v.name, ok: false, error: rpcErr.message }); continue; }
      const { data: sc } = await admin.from("vendor_scorecards")
        .select("on_time_delivery_pct, invoice_accuracy_pct, avg_acknowledgment_hours, po_count, invoice_count, discrepancy_count, composite_score")
        .eq("id", scId).maybeSingle();
      results.push({ vendor_id: v.id, name: v.name, ok: true, scorecard_id: scId, ...(sc || {}) });
    } catch (err) {
      results.push({ vendor_id: v.id, name: v.name, ok: false, error: err?.message || String(err) });
    }
  }

  return res.status(200).json({ period_start, period_end, count: results.length, results });
}
