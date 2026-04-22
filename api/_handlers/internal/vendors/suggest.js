// api/internal/vendors/suggest
//
// GET — top 3 vendors for a given category, ranked by:
//   1. preferred rank (lower = better; non-preferred sorts last)
//   2. live health score (higher = better)
//   3. on_time_delivery_pct (higher = better)
//   4. price competitiveness — lower avg catalog unit_price in that
//      category is better (null if the vendor has no catalog rows in
//      the category)
//
// Query:
//   ?category=<text>   (required — matches catalog_items.category AND
//                        preferred_vendors.category)
//   ?amount=<number>   (optional, surfaced as context — not a ranking
//                        factor today)
//
// Response:
//   {
//     category, amount,
//     suggestions: [
//       { vendor_id, name, rank: 1|2|3,
//         preferred: { rank, notes } | null,
//         health_score, on_time_delivery_pct, avg_unit_price,
//         price_competitiveness_pct,   // 100 = cheapest, 0 = most expensive
//         kpi: {...}, why: [ "...", "..." ] }
//     ]
//   }
//
// Literal path takes precedence over the [id] dynamic sibling.

import { createClient } from "@supabase/supabase-js";
import { composeHealth } from "../../../_lib/analytics.js";

export const config = { maxDuration: 30 };

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
  const category = (url.searchParams.get("category") || "").trim();
  const amount = url.searchParams.get("amount") ? Number(url.searchParams.get("amount")) : null;
  if (!category) return res.status(400).json({ error: "category is required" });

  const [vRes, prefRes, kpiRes, catRes, docTypesRes, docsRes, invRes] = await Promise.all([
    admin.from("vendors").select("id, name, status").is("deleted_at", null),
    admin.from("preferred_vendors").select("*").eq("category", category),
    admin.from("vendor_kpi_live").select("vendor_id, on_time_delivery_pct, invoice_accuracy_pct, invoice_count, discrepancy_count, avg_acknowledgment_hours"),
    admin.from("catalog_items").select("vendor_id, unit_price, status").eq("category", category).eq("status", "active"),
    admin.from("compliance_document_types").select("id").eq("active", true).eq("required", true),
    admin.from("compliance_documents").select("vendor_id, document_type_id, status, expiry_date, uploaded_at"),
    admin.from("invoices").select("vendor_id, status, due_date"),
  ]);
  const errs = [vRes, prefRes, kpiRes, catRes, docTypesRes, docsRes, invRes].filter((r) => r.error);
  if (errs.length) return res.status(500).json({ error: errs[0].error.message });

  const activeVendors = (vRes.data || []).filter((v) => (v.status || "active") === "active");
  const prefByVendor = new Map((prefRes.data || []).map((p) => [p.vendor_id, p]));
  const kpiByVendor = new Map((kpiRes.data || []).map((k) => [k.vendor_id, k]));
  const requiredIds = (docTypesRes.data || []).map((t) => t.id);
  const now = new Date();

  // Avg unit_price in this category per vendor
  const priceByVendor = new Map();
  for (const c of catRes.data || []) {
    const n = Number(c.unit_price);
    if (!Number.isFinite(n)) continue;
    const arr = priceByVendor.get(c.vendor_id) || [];
    arr.push(n);
    priceByVendor.set(c.vendor_id, arr);
  }
  const avgPrice = new Map();
  for (const [vid, prices] of priceByVendor.entries()) {
    avgPrice.set(vid, prices.reduce((a, b) => a + b, 0) / prices.length);
  }

  // Compliance + overdue — per vendor
  const latestByVendor = new Map();
  for (const d of docsRes.data || []) {
    const key = `${d.vendor_id}|${d.document_type_id}`;
    const prev = latestByVendor.get(key);
    if (!prev || new Date(d.uploaded_at) > new Date(prev.uploaded_at)) latestByVendor.set(key, d);
  }
  function approvedDocs(vid) {
    let n = 0;
    for (const tid of requiredIds) {
      const d = latestByVendor.get(`${vid}|${tid}`);
      if (!d || d.status !== "approved") continue;
      if (d.expiry_date && new Date(d.expiry_date).getTime() < now.getTime()) continue;
      n++;
    }
    return n;
  }
  const invByVendor = new Map();
  for (const i of invRes.data || []) {
    const arr = invByVendor.get(i.vendor_id) || [];
    arr.push(i);
    invByVendor.set(i.vendor_id, arr);
  }
  function overdue(vid) {
    return (invByVendor.get(vid) || []).filter((i) =>
      i.status !== "paid" && i.status !== "rejected" && i.due_date && new Date(i.due_date) < now
    ).length;
  }

  // Candidate pool: preferred vendors for this category OR vendors with
  // at least one active catalog item in the category. Falling back to
  // the full active pool if neither list surfaces enough rows.
  const candidateIds = new Set();
  for (const p of prefRes.data || []) candidateIds.add(p.vendor_id);
  for (const c of catRes.data || []) candidateIds.add(c.vendor_id);
  if (candidateIds.size < 3) {
    for (const v of activeVendors) candidateIds.add(v.id);
  }

  const candidates = [];
  for (const v of activeVendors) {
    if (!candidateIds.has(v.id)) continue;
    const kpi = kpiByVendor.get(v.id);
    const comp = composeHealth({
      on_time_delivery_pct: kpi?.on_time_delivery_pct,
      invoice_count: kpi?.invoice_count,
      discrepancy_count: kpi?.discrepancy_count,
      approved_docs: approvedDocs(v.id),
      required_docs: requiredIds.length,
      overdue_invoices: overdue(v.id),
      avg_acknowledgment_hours: kpi?.avg_acknowledgment_hours,
    });
    const pref = prefByVendor.get(v.id);
    candidates.push({
      vendor: v,
      pref: pref ? { id: pref.id, rank: pref.rank, notes: pref.notes } : null,
      health_score: comp.overall,
      on_time_delivery_pct: kpi?.on_time_delivery_pct == null ? null : Number(kpi.on_time_delivery_pct),
      avg_unit_price: avgPrice.get(v.id) ?? null,
      kpi: kpi ? {
        on_time_delivery_pct: kpi.on_time_delivery_pct == null ? null : Number(kpi.on_time_delivery_pct),
        invoice_accuracy_pct: kpi.invoice_accuracy_pct == null ? null : Number(kpi.invoice_accuracy_pct),
        avg_acknowledgment_hours: kpi.avg_acknowledgment_hours == null ? null : Number(kpi.avg_acknowledgment_hours),
      } : null,
    });
  }

  // Price competitiveness on a 0..100 scale — 100 = cheapest candidate
  const prices = candidates.map((c) => c.avg_unit_price).filter((p) => p != null);
  const pMin = prices.length ? Math.min(...prices) : null;
  const pMax = prices.length ? Math.max(...prices) : null;
  for (const c of candidates) {
    if (c.avg_unit_price == null || pMin == null || pMax == null || pMax === pMin) {
      c.price_competitiveness_pct = c.avg_unit_price == null ? null : 50;
    } else {
      c.price_competitiveness_pct = Math.round(100 - (c.avg_unit_price - pMin) / (pMax - pMin) * 100);
    }
  }

  candidates.sort((a, b) => {
    const ar = a.pref?.rank ?? 999;
    const br = b.pref?.rank ?? 999;
    if (ar !== br) return ar - br;
    if ((b.health_score ?? -1) !== (a.health_score ?? -1)) return (b.health_score ?? -1) - (a.health_score ?? -1);
    if ((b.on_time_delivery_pct ?? -1) !== (a.on_time_delivery_pct ?? -1)) return (b.on_time_delivery_pct ?? -1) - (a.on_time_delivery_pct ?? -1);
    return (b.price_competitiveness_pct ?? -1) - (a.price_competitiveness_pct ?? -1);
  });

  const top3 = candidates.slice(0, 3).map((c, i) => ({
    rank: i + 1,
    vendor_id: c.vendor.id,
    name: c.vendor.name,
    preferred: c.pref,
    health_score: c.health_score,
    on_time_delivery_pct: c.on_time_delivery_pct,
    avg_unit_price: c.avg_unit_price,
    price_competitiveness_pct: c.price_competitiveness_pct,
    kpi: c.kpi,
    why: [
      c.pref ? `Preferred rank ${c.pref.rank} for ${category}` : "Not preferred for this category",
      `Health score ${c.health_score}`,
      c.on_time_delivery_pct != null ? `On-time delivery ${c.on_time_delivery_pct}%` : "No on-time data",
      c.price_competitiveness_pct != null ? `Price competitiveness ${c.price_competitiveness_pct}/100 (avg $${Number(c.avg_unit_price).toFixed(2)})` : "No catalog pricing in this category",
    ],
  }));

  return res.status(200).json({
    category,
    amount,
    candidate_count: candidates.length,
    suggestions: top3,
  });
}
