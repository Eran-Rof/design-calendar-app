// api/internal/anomalies
//
// GET — all open anomaly flags with optional filters.
//   ?type=duplicate_invoice|price_variance|unusual_volume|late_pattern|compliance_gap
//   ?severity=low|medium|high|critical
//   ?vendor_id=uuid
//   ?status=open|reviewed|dismissed|escalated (default open)
// Order: severity desc (critical > high > medium > low), detected_at asc
// (oldest critical first).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const type = url.searchParams.get("type");
  const severity = url.searchParams.get("severity");
  const vendorId = url.searchParams.get("vendor_id");
  const status = url.searchParams.get("status") || "open";

  let q = admin.from("anomaly_flags").select("*, vendor:vendors(id, name)").eq("status", status);
  if (type) q = q.eq("type", type);
  if (severity) q = q.eq("severity", severity);
  if (vendorId) q = q.eq("vendor_id", vendorId);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const sorted = (data || []).slice().sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity] || 0;
    const rb = SEVERITY_RANK[b.severity] || 0;
    if (ra !== rb) return rb - ra;
    return new Date(a.detected_at).getTime() - new Date(b.detected_at).getTime();
  });

  return res.status(200).json(sorted);
}
