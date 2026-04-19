// api/internal/analytics/categories
//
// GET — spend breakdown by keyword-derived category across all vendors.
//
// Query:
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD    defaults to last 12 months
//
// Response:
//   {
//     range: { from, to },
//     categories: [
//       { category, spend, po_count, line_count, top_vendors: [{vendor_id, name, spend}] }
//     ],
//     uncategorized_share: 0..1
//   }
//
// Categorization uses the CATEGORIES regex list in _lib/analytics.js.
// Line-item level: spend is allocated line-by-line so a mixed PO counts
// against every matching category.

import { createClient } from "@supabase/supabase-js";
import { categorize } from "../../_lib/analytics.js";

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
  const today = new Date();
  const defaultFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));
  const defaultTo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const fromDate = url.searchParams.get("from") || defaultFrom.toISOString().slice(0, 10);
  const toDate = url.searchParams.get("to") || defaultTo.toISOString().slice(0, 10);

  const [vRes, posRes, pliRes] = await Promise.all([
    admin.from("vendors").select("id, name").is("deleted_at", null),
    admin.from("tanda_pos").select("uuid_id, vendor_id, data"),
    admin.from("po_line_items").select("po_id, description, line_total"),
  ]);
  if (vRes.error)   return res.status(500).json({ error: vRes.error.message });
  if (posRes.error) return res.status(500).json({ error: posRes.error.message });
  if (pliRes.error) return res.status(500).json({ error: pliRes.error.message });

  const vendorsById = new Map((vRes.data || []).map((v) => [v.id, v.name]));
  const pliByPo = new Map();
  for (const li of pliRes.data || []) {
    const arr = pliByPo.get(li.po_id) || [];
    arr.push(li);
    pliByPo.set(li.po_id, arr);
  }

  const byCat = new Map();
  let totalSpend = 0;

  for (const po of posRes.data || []) {
    if (!po.data?.DateOrder) continue;
    const d = po.data.DateOrder.slice(0, 10);
    if (d < fromDate || d > toDate) continue;
    if (po.data._archived) continue;
    const amount = Number(po.data.TotalAmount) || 0;
    totalSpend += amount;
    const lines = pliByPo.get(po.uuid_id) || [];

    const allocations = new Map();
    if (lines.length > 0) {
      const lineSum = lines.reduce((a, l) => a + (Number(l.line_total) || 0), 0) || 1;
      for (const l of lines) {
        const cat = categorize(l.description);
        const alloc = amount * (Number(l.line_total) || 0) / lineSum;
        allocations.set(cat, (allocations.get(cat) || 0) + alloc);
      }
    } else {
      allocations.set("Other", amount);
    }

    for (const [cat, val] of allocations.entries()) {
      const row = byCat.get(cat) || { category: cat, spend: 0, po_count: 0, line_count: 0, byVendor: new Map() };
      row.spend += val;
      row.po_count += 1;
      row.line_count += lines.filter((l) => categorize(l.description) === cat).length || (cat === "Other" ? 1 : 0);
      const vName = vendorsById.get(po.vendor_id) || "Unknown";
      const vRow = row.byVendor.get(po.vendor_id) || { vendor_id: po.vendor_id, name: vName, spend: 0 };
      vRow.spend += val;
      row.byVendor.set(po.vendor_id, vRow);
      byCat.set(cat, row);
    }
  }

  const categories = [...byCat.values()]
    .map((r) => ({
      category: r.category,
      spend: Math.round(r.spend * 100) / 100,
      po_count: r.po_count,
      line_count: r.line_count,
      top_vendors: [...r.byVendor.values()]
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 5)
        .map((v) => ({ ...v, spend: Math.round(v.spend * 100) / 100 })),
    }))
    .sort((a, b) => b.spend - a.spend);

  const other = categories.find((c) => c.category === "Other");
  return res.status(200).json({
    range: { from: fromDate, to: toDate },
    categories,
    uncategorized_share: totalSpend > 0 ? (other ? Math.round(other.spend / totalSpend * 1000) / 1000 : 0) : 0,
  });
}
