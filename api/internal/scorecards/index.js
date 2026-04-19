// api/internal/scorecards/index.js
//
// GET — all vendors' LATEST scorecards.
//   ?sort=<composite|on_time|accuracy|ack|po_count>  (default: composite)
//   ?order=<asc|desc>                                 (default: desc)
//   ?flagged_only=true                                 (on_time<80 OR accuracy<85)
//
// Response row:
//   { vendor_id, vendor_name, period_start, period_end,
//     on_time_delivery_pct, invoice_accuracy_pct, avg_acknowledgment_hours,
//     po_count, invoice_count, discrepancy_count, composite_score,
//     flagged: boolean, flag_reasons: string[] }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const ON_TIME_THRESHOLD = 80;
const ACCURACY_THRESHOLD = 85;

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
  const sort = url.searchParams.get("sort") || "composite";
  const order = (url.searchParams.get("order") || "desc").toLowerCase();
  const flaggedOnly = url.searchParams.get("flagged_only") === "true";

  // Fetch everything and reduce to latest per vendor in-app; DISTINCT ON
  // would be cleaner but PostgREST doesn't expose it. At realistic scale
  // (hundreds of vendors × N periods) this is trivial.
  const [scRes, vRes] = await Promise.all([
    admin.from("vendor_scorecards").select("*").order("period_end", { ascending: false }),
    admin.from("vendors").select("id, name").is("deleted_at", null),
  ]);
  if (scRes.error) return res.status(500).json({ error: scRes.error.message });
  if (vRes.error)  return res.status(500).json({ error: vRes.error.message });

  const vendorName = new Map((vRes.data || []).map((v) => [v.id, v.name]));
  const latestByVendor = new Map();
  for (const sc of scRes.data || []) {
    if (!latestByVendor.has(sc.vendor_id)) latestByVendor.set(sc.vendor_id, sc);
  }

  let rows = Array.from(latestByVendor.values()).map((sc) => {
    const flag_reasons = [];
    if (sc.on_time_delivery_pct != null && Number(sc.on_time_delivery_pct) < ON_TIME_THRESHOLD) {
      flag_reasons.push(`on-time ${sc.on_time_delivery_pct}% < ${ON_TIME_THRESHOLD}%`);
    }
    if (sc.invoice_accuracy_pct != null && Number(sc.invoice_accuracy_pct) < ACCURACY_THRESHOLD) {
      flag_reasons.push(`accuracy ${sc.invoice_accuracy_pct}% < ${ACCURACY_THRESHOLD}%`);
    }
    return {
      ...sc,
      vendor_name: vendorName.get(sc.vendor_id) || null,
      flagged: flag_reasons.length > 0,
      flag_reasons,
    };
  });

  if (flaggedOnly) rows = rows.filter((r) => r.flagged);

  const sortKey = {
    composite: "composite_score",
    on_time: "on_time_delivery_pct",
    accuracy: "invoice_accuracy_pct",
    ack: "avg_acknowledgment_hours",
    po_count: "po_count",
  }[sort] || "composite_score";

  rows.sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    const na = av == null ? (sortKey === "avg_acknowledgment_hours" ? Infinity : -Infinity) : Number(av);
    const nb = bv == null ? (sortKey === "avg_acknowledgment_hours" ? Infinity : -Infinity) : Number(bv);
    // avg_acknowledgment_hours is "lower is better", everything else "higher is better"
    const lowerIsBetter = sortKey === "avg_acknowledgment_hours";
    const diff = lowerIsBetter ? na - nb : nb - na;
    return order === "asc" ? -diff : diff;
  });

  return res.status(200).json(rows);
}
