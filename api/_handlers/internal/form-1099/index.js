// api/internal/form-1099  (h626)
//
// P25 / M20 — 1099 vendor worksheet. Lists vendors flagged `is_1099_vendor`
// with their tax ID and the total AP paid to them in a calendar year (the
// cash-basis 1099-NEC figure). MVP: sums `invoices.paid_amount_cents` for the
// vendor where `paid_at` falls in the year. (Box mapping / e-file are deferred.)
//
//   GET /api/internal/form-1099?year=YYYY&threshold_cents=60000

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const year = parseInt(url.searchParams.get("year") || String(new Date().getUTCFullYear()), 10);
  const threshold = parseInt(url.searchParams.get("threshold_cents") || "60000", 10); // IRS 1099-NEC: $600
  const from = `${year}-01-01`, to = `${year}-12-31`;

  // 1099 vendors.
  const { data: vendors, error: vErr } = await admin
    .from("vendors").select("id, name, code, tax_id").eq("is_1099_vendor", true).is("deleted_at", null);
  if (vErr) return res.status(500).json({ error: vErr.message });
  if (!vendors || vendors.length === 0) return res.status(200).json({ year, threshold_cents: threshold, rows: [] });

  const vendorIds = vendors.map((v) => v.id);
  // Sum paid AP to those vendors in-year (paid_at within the year, paid amount).
  const paidByVendor = new Map();
  for (let i = 0; i < vendorIds.length; i += 100) {
    const { data: invs } = await admin.from("invoices")
      .select("vendor_id, paid_amount_cents, paid_at")
      .in("vendor_id", vendorIds.slice(i, i + 100))
      .gte("paid_at", `${from}T00:00:00Z`).lte("paid_at", `${to}T23:59:59Z`);
    for (const inv of invs || []) {
      paidByVendor.set(inv.vendor_id, (paidByVendor.get(inv.vendor_id) || 0) + (Number(inv.paid_amount_cents) || 0));
    }
  }

  const rows = vendors.map((v) => ({
    vendor_id: v.id, name: v.name, code: v.code, has_tax_id: !!v.tax_id,
    paid_cents: paidByVendor.get(v.id) || 0,
    reportable: (paidByVendor.get(v.id) || 0) >= threshold,
  })).sort((a, b) => b.paid_cents - a.paid_cents);

  return res.status(200).json({
    year, threshold_cents: threshold,
    rows,
    summary: { vendors: rows.length, reportable: rows.filter((r) => r.reportable).length, missing_tax_id: rows.filter((r) => r.reportable && !r.has_tax_id).length },
  });
}
