// api/internal/analytics/spend
//
// GET — total spend aggregated across vendors for a date range.
//
// Query params:
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   (defaults: last 12 months)
//   ?vendor_id=uuid                  filter to one vendor
//   ?category=Apparel                filter to one keyword-derived category
//
// Response:
//   {
//     range: { from, to },
//     totals: { spend, po_count, vendor_count },
//     by_vendor: [ { vendor_id, name, spend, po_count } ],   // descending
//     by_month:  [ { month: "YYYY-MM", spend, po_count } ],  // oldest first
//     by_category: [ { category, spend, po_count } ],
//     top_10_vendors: [ { vendor_id, name, spend, po_count } ],
//     yoy: { current, prior, change_pct }   // same-date range a year ago
//   }
//
// Source: tanda_pos.data.TotalAmount + DateOrder. PO line items are
// used for category classification (line-item level, so a single PO
// can hit multiple categories — spend is allocated pro-rata to each
// matching line's line_total).

import { createClient } from "@supabase/supabase-js";
import { categorize, monthKey } from "../../../_lib/analytics.js";

export const config = { maxDuration: 45 };

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
  const vendorId = url.searchParams.get("vendor_id");
  const categoryFilter = url.searchParams.get("category");
  const today = new Date();
  const defaultFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));
  const defaultTo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const fromDate = url.searchParams.get("from") || defaultFrom.toISOString().slice(0, 10);
  const toDate = url.searchParams.get("to") || defaultTo.toISOString().slice(0, 10);

  // Fetch vendor directory + all POs (data field contains DateOrder + TotalAmount)
  const [vRes, posRes, pliRes] = await Promise.all([
    admin.from("vendors").select("id, name").is("deleted_at", null),
    admin.from("tanda_pos").select("uuid_id, vendor_id, po_number, data"),
    admin.from("po_line_items").select("po_id, description, line_total"),
  ]);
  if (vRes.error)   return res.status(500).json({ error: vRes.error.message });
  if (posRes.error) return res.status(500).json({ error: posRes.error.message });
  if (pliRes.error) return res.status(500).json({ error: pliRes.error.message });

  const vendorsById = new Map((vRes.data || []).map((v) => [v.id, v.name]));
  const allPos = posRes.data || [];
  const pliByPo = new Map();
  for (const li of pliRes.data || []) {
    const arr = pliByPo.get(li.po_id) || [];
    arr.push(li);
    pliByPo.set(li.po_id, arr);
  }

  function inRange(dateStr, a, b) {
    if (!dateStr) return false;
    const d = dateStr.slice(0, 10);
    return d >= a && d <= b;
  }

  function aggregate(fromD, toD) {
    const byVendor = new Map();
    const byMonth = new Map();
    const byCategory = new Map();
    let totalSpend = 0, totalPoCount = 0;

    for (const po of allPos) {
      if (!po.data?.DateOrder) continue;
      if (!inRange(po.data.DateOrder, fromD, toD)) continue;
      if (po.data._archived) continue;
      if (vendorId && po.vendor_id !== vendorId) continue;

      const amount = Number(po.data.TotalAmount) || 0;

      // PO-level breakdown by category depends on line items
      const lines = pliByPo.get(po.uuid_id) || [];
      const poCategories = new Map(); // category → allocated spend
      if (lines.length > 0) {
        const lineSum = lines.reduce((a, l) => a + (Number(l.line_total) || 0), 0) || 1;
        for (const l of lines) {
          const cat = categorize(l.description);
          const alloc = amount * (Number(l.line_total) || 0) / lineSum;
          poCategories.set(cat, (poCategories.get(cat) || 0) + alloc);
        }
      } else {
        poCategories.set("Other", amount);
      }

      if (categoryFilter && !poCategories.has(categoryFilter)) continue;
      const effectiveAmount = categoryFilter ? (poCategories.get(categoryFilter) || 0) : amount;

      totalSpend += effectiveAmount;
      totalPoCount++;

      const vName = vendorsById.get(po.vendor_id) || "Unknown";
      const vRow = byVendor.get(po.vendor_id) || { vendor_id: po.vendor_id, name: vName, spend: 0, po_count: 0 };
      vRow.spend += effectiveAmount;
      vRow.po_count++;
      byVendor.set(po.vendor_id, vRow);

      const mk = monthKey(po.data.DateOrder);
      const mRow = byMonth.get(mk) || { month: mk, spend: 0, po_count: 0 };
      mRow.spend += effectiveAmount;
      mRow.po_count++;
      byMonth.set(mk, mRow);

      for (const [cat, val] of poCategories.entries()) {
        if (categoryFilter && cat !== categoryFilter) continue;
        const cRow = byCategory.get(cat) || { category: cat, spend: 0, po_count: 0 };
        cRow.spend += val;
        // PO is counted once per category it touches
        cRow.po_count = cRow.po_count + (val > 0 ? 1 : 0);
        byCategory.set(cat, cRow);
      }
    }
    return {
      totals: { spend: totalSpend, po_count: totalPoCount, vendor_count: byVendor.size },
      by_vendor: [...byVendor.values()].sort((a, b) => b.spend - a.spend),
      by_month:  [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
      by_category: [...byCategory.values()].sort((a, b) => b.spend - a.spend),
    };
  }

  const current = aggregate(fromDate, toDate);

  // YoY — shift the same range back one year
  const oneYearAgo = (s) => {
    const d = new Date(`${s}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  };
  const prior = aggregate(oneYearAgo(fromDate), oneYearAgo(toDate));

  return res.status(200).json({
    range: { from: fromDate, to: toDate },
    ...current,
    top_10_vendors: current.by_vendor.slice(0, 10),
    yoy: {
      current: current.totals.spend,
      prior:   prior.totals.spend,
      change_pct: prior.totals.spend > 0
        ? Math.round((current.totals.spend - prior.totals.spend) / prior.totals.spend * 1000) / 10
        : null,
    },
  });
}
