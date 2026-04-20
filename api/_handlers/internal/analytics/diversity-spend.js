// api/internal/analytics/diversity-spend
//
// GET — diversity-spend share for a period.
//   ?from=<YYYY-MM-DD>&to=<YYYY-MM-DD>  default: last 12 months
// Response: { range, total_spend, diversity_spend, pct,
//             by_business_type: [{ type, spend, pct }], top_vendors }

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

  const url = new URL(req.url, `https://${req.headers.host}`);
  let from = url.searchParams.get("from");
  let to   = url.searchParams.get("to");
  if (!from) {
    const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 12);
    from = d.toISOString().slice(0, 10);
  }
  if (!to) to = new Date().toISOString().slice(0, 10);

  const [{ data: invoices }, { data: profiles }, { data: vendors }] = await Promise.all([
    admin.from("invoices").select("vendor_id, total, status, invoice_date")
      .in("status", ["approved", "paid"]).gte("invoice_date", from).lte("invoice_date", to),
    admin.from("diversity_profiles").select("vendor_id, business_type, verified").eq("verified", true),
    admin.from("vendors").select("id, name"),
  ]);

  const vendorName = {};
  for (const v of vendors || []) vendorName[v.id] = v.name;

  const profileByVendor = {};
  for (const p of profiles || []) profileByVendor[p.vendor_id] = p;

  let total = 0;
  let diversitySpend = 0;
  const byBusinessType = {};
  const byVendor = {};

  for (const inv of invoices || []) {
    const amt = Number(inv.total || 0);
    total += amt;
    const p = profileByVendor[inv.vendor_id];
    if (!p) continue;
    diversitySpend += amt;
    byVendor[inv.vendor_id] = (byVendor[inv.vendor_id] || 0) + amt;
    for (const t of p.business_type || []) {
      byBusinessType[t] = (byBusinessType[t] || 0) + amt;
    }
  }

  const pct = total > 0 ? (diversitySpend / total) * 100 : 0;
  const byBusinessTypeArr = Object.entries(byBusinessType)
    .map(([type, spend]) => ({ type, spend, pct: total > 0 ? (spend / total) * 100 : 0 }))
    .sort((a, b) => b.spend - a.spend);
  const topVendors = Object.entries(byVendor)
    .map(([vendor_id, spend]) => ({ vendor_id, name: vendorName[vendor_id] || vendor_id, spend }))
    .sort((a, b) => b.spend - a.spend).slice(0, 10);

  return res.status(200).json({
    range: { from, to },
    total_spend: Math.round(total),
    diversity_spend: Math.round(diversitySpend),
    pct: Number(pct.toFixed(2)),
    by_business_type: byBusinessTypeArr,
    top_vendors: topVendors,
  });
}
