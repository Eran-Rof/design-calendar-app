// api/internal/reports/spend.js
//
// GET — spend time-series suitable for charts.
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   (defaults: Jan 1 current year → today)
//   ?vendor_id=<uuid>                (optional filter)
//
// Spend definition: sum of invoices.total with status='paid' grouped by
// paid_at month. "Category" comes from tanda_pos.data.OrderClassName or
// data.ProjectClassName via the invoice's po_id — not always present,
// so rows without a category fall into 'Uncategorised'.
//
// Response:
//   {
//     period: { from, to },
//     by_month:           [{ month: "2026-04", total }, ...],
//     by_vendor:          [{ vendor_id, vendor_name, total }, ...],
//     by_vendor_month:    [{ vendor_id, vendor_name, month, total }, ...],
//     by_category:        [{ category, total }, ...],
//     by_category_month:  [{ category, month, total }, ...],
//     grand_total: number
//   }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

function monthKey(iso) {
  return iso ? iso.slice(0, 7) : null;
}

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
  const year = new Date().getFullYear();
  const fromDate = url.searchParams.get("from") || `${year}-01-01`;
  const toDate = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
  const vendorIdFilter = url.searchParams.get("vendor_id");

  let invQ = admin.from("invoices")
    .select("vendor_id, po_id, total, paid_at")
    .eq("status", "paid")
    .gte("paid_at", fromDate + "T00:00:00")
    .lte("paid_at", toDate + "T23:59:59");
  if (vendorIdFilter) invQ = invQ.eq("vendor_id", vendorIdFilter);

  const [invRes, vRes, posRes] = await Promise.all([
    invQ,
    admin.from("vendors").select("id, name"),
    admin.from("tanda_pos").select("uuid_id, data"),
  ]);
  if (invRes.error) return res.status(500).json({ error: invRes.error.message });
  if (vRes.error)   return res.status(500).json({ error: vRes.error.message });
  if (posRes.error) return res.status(500).json({ error: posRes.error.message });

  const invoices = invRes.data || [];
  const vendorName = new Map((vRes.data || []).map((v) => [v.id, v.name]));
  const poCategory = new Map();
  for (const p of posRes.data || []) {
    const cat = p.data?.OrderClassName || p.data?.ProjectClassName || p.data?.BuyerName || null;
    poCategory.set(p.uuid_id, cat || "Uncategorised");
  }

  const byMonth = new Map();
  const byVendor = new Map();
  const byVendorMonth = new Map();
  const byCategory = new Map();
  const byCategoryMonth = new Map();
  let grand = 0;

  for (const i of invoices) {
    const amount = Number(i.total) || 0;
    grand += amount;
    const mk = monthKey(i.paid_at);
    if (!mk) continue;

    byMonth.set(mk, (byMonth.get(mk) || 0) + amount);

    const vid = i.vendor_id || "";
    byVendor.set(vid, (byVendor.get(vid) || 0) + amount);
    const vmKey = `${vid}|${mk}`;
    byVendorMonth.set(vmKey, (byVendorMonth.get(vmKey) || 0) + amount);

    const cat = i.po_id ? (poCategory.get(i.po_id) || "Uncategorised") : "Uncategorised";
    byCategory.set(cat, (byCategory.get(cat) || 0) + amount);
    const cmKey = `${cat}|${mk}`;
    byCategoryMonth.set(cmKey, (byCategoryMonth.get(cmKey) || 0) + amount);
  }

  const round = (n) => Math.round(n * 100) / 100;

  return res.status(200).json({
    period: { from: fromDate, to: toDate },
    grand_total: round(grand),
    by_month: Array.from(byMonth.entries())
      .map(([month, total]) => ({ month, total: round(total) }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    by_vendor: Array.from(byVendor.entries())
      .map(([vendor_id, total]) => ({ vendor_id, vendor_name: vendorName.get(vendor_id) || null, total: round(total) }))
      .sort((a, b) => b.total - a.total),
    by_vendor_month: Array.from(byVendorMonth.entries())
      .map(([k, total]) => {
        const [vendor_id, month] = k.split("|");
        return { vendor_id, vendor_name: vendorName.get(vendor_id) || null, month, total: round(total) };
      })
      .sort((a, b) => a.month.localeCompare(b.month) || b.total - a.total),
    by_category: Array.from(byCategory.entries())
      .map(([category, total]) => ({ category, total: round(total) }))
      .sort((a, b) => b.total - a.total),
    by_category_month: Array.from(byCategoryMonth.entries())
      .map(([k, total]) => {
        const [category, month] = k.split("|");
        return { category, month, total: round(total) };
      })
      .sort((a, b) => a.month.localeCompare(b.month) || b.total - a.total),
  });
}
