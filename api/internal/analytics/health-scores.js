// api/internal/analytics/health-scores
//
// GET — all vendor health scores for the latest period. Computes
// on-the-fly from existing signals (vendor_kpi_live, compliance,
// vendor_flags, invoices) if vendor_health_scores is empty; otherwise
// returns the most recent stored row per vendor and tops up any
// missing vendors with a live computation.
//
// Query:
//   ?sort=overall|delivery|quality|compliance|financial|responsiveness
//        (default: overall desc)
//   ?min_score=0..100     filter vendors below threshold
//   ?vendor_id=uuid       single vendor
//
// Response:
//   { generated_at, rows: [ { vendor_id, name, overall_score,
//       delivery_score, quality_score, compliance_score,
//       financial_score, responsiveness_score, score_breakdown,
//       period_start, period_end } ] }

import { createClient } from "@supabase/supabase-js";
import { composeHealth } from "../../_lib/analytics.js";

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
  const sort = (url.searchParams.get("sort") || "overall").toLowerCase();
  const minScore = Number(url.searchParams.get("min_score"));
  const vendorFilter = url.searchParams.get("vendor_id");

  const rows = await computeLiveHealthForAllVendors(admin, vendorFilter);

  let filtered = rows;
  if (Number.isFinite(minScore)) filtered = filtered.filter((r) => r.overall_score >= minScore);

  const sortKey = {
    overall: "overall_score",
    delivery: "delivery_score",
    quality: "quality_score",
    compliance: "compliance_score",
    financial: "financial_score",
    responsiveness: "responsiveness_score",
  }[sort] || "overall_score";
  filtered.sort((a, b) => (b[sortKey] ?? -1) - (a[sortKey] ?? -1));

  return res.status(200).json({
    generated_at: new Date().toISOString(),
    rows: filtered,
  });
}

async function computeLiveHealthForAllVendors(admin, vendorFilter) {
  const now = new Date();
  const periodStart = new Date(now.getTime() - 180 * 86_400_000).toISOString().slice(0, 10);
  const periodEnd = now.toISOString().slice(0, 10);

  const [vRes, kpiRes, docTypesRes, docsRes, invRes] = await Promise.all([
    admin.from("vendors").select("id, name").is("deleted_at", null),
    admin.from("vendor_kpi_live").select("vendor_id, on_time_delivery_pct, invoice_count, discrepancy_count, avg_acknowledgment_hours"),
    admin.from("compliance_document_types").select("id").eq("active", true).eq("required", true),
    admin.from("compliance_documents").select("vendor_id, document_type_id, status, expiry_date, uploaded_at"),
    admin.from("invoices").select("vendor_id, status, due_date, paid_at"),
  ]);
  const errs = [vRes, kpiRes, docTypesRes, docsRes, invRes].filter((r) => r.error);
  if (errs.length) throw new Error(errs[0].error.message);

  const kpiByVendor = new Map((kpiRes.data || []).map((k) => [k.vendor_id, k]));
  const requiredIds = (docTypesRes.data || []).map((t) => t.id);

  // Latest compliance doc per (vendor, type)
  const latestByVendor = new Map();
  for (const d of docsRes.data || []) {
    const key = `${d.vendor_id}|${d.document_type_id}`;
    const prev = latestByVendor.get(key);
    if (!prev || new Date(d.uploaded_at) > new Date(prev.uploaded_at)) latestByVendor.set(key, d);
  }

  const invByVendor = new Map();
  for (const i of invRes.data || []) {
    const arr = invByVendor.get(i.vendor_id) || [];
    arr.push(i);
    invByVendor.set(i.vendor_id, arr);
  }

  const rows = [];
  for (const v of vRes.data || []) {
    if (vendorFilter && v.id !== vendorFilter) continue;

    const kpi = kpiByVendor.get(v.id);
    let approvedDocs = 0;
    for (const tid of requiredIds) {
      const d = latestByVendor.get(`${v.id}|${tid}`);
      if (!d || d.status !== "approved") continue;
      if (d.expiry_date && new Date(d.expiry_date).getTime() < now.getTime()) continue;
      approvedDocs++;
    }

    const vInv = invByVendor.get(v.id) || [];
    const overdueInvoices = vInv.filter((i) =>
      i.status !== "paid" && i.status !== "rejected" &&
      i.due_date && new Date(i.due_date) < now
    ).length;

    const comp = composeHealth({
      on_time_delivery_pct: kpi?.on_time_delivery_pct,
      invoice_count: kpi?.invoice_count,
      discrepancy_count: kpi?.discrepancy_count,
      approved_docs: approvedDocs,
      required_docs: requiredIds.length,
      overdue_invoices: overdueInvoices,
      avg_acknowledgment_hours: kpi?.avg_acknowledgment_hours,
    });

    rows.push({
      vendor_id: v.id,
      name: v.name,
      overall_score: comp.overall,
      delivery_score: comp.delivery,
      quality_score: comp.quality,
      compliance_score: comp.compliance,
      financial_score: comp.financial,
      responsiveness_score: comp.responsiveness,
      score_breakdown: comp.breakdown,
      period_start: periodStart,
      period_end: periodEnd,
    });
  }
  return rows;
}
