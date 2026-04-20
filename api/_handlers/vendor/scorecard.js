// api/vendor/scorecard.js
//
// GET — last 4 scorecard periods for the caller's vendor.
// Response:
//   [{ period_start, period_end, on_time_delivery_pct,
//      invoice_accuracy_pct, avg_acknowledgment_hours, po_count,
//      invoice_count, discrepancy_count, composite_score,
//      generated_at }]

import { createClient } from "@supabase/supabase-js";

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

  const jwt = req.headers.authorization && req.headers.authorization.startsWith("Bearer ")
    ? req.headers.authorization.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: "Authentication required" });
  const { data: userRes, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !userRes?.user) return res.status(401).json({ error: "Invalid or expired token" });

  const { data: vu } = await admin.from("vendor_users").select("vendor_id").eq("auth_id", userRes.user.id).maybeSingle();
  if (!vu) return res.status(403).json({ error: "Not linked to a vendor" });

  const { data, error } = await admin
    .from("vendor_scorecards")
    .select("period_start, period_end, on_time_delivery_pct, invoice_accuracy_pct, avg_acknowledgment_hours, po_count, invoice_count, discrepancy_count, composite_score, generated_at")
    .eq("vendor_id", vu.vendor_id)
    .order("period_start", { ascending: false })
    .limit(4);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json(data || []);
}
