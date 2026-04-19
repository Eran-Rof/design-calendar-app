// api/vendor/analytics/health
//
// GET — the caller's vendor health score + breakdown, with a 4-period
// trend if snapshotted rows exist in vendor_health_scores.
//
// Response:
//   {
//     current: { period_start, period_end, overall, delivery, quality,
//                compliance, financial, responsiveness, breakdown },
//     trend: [ { period_start, period_end, overall } ]   // oldest → newest
//   }

import { createClient } from "@supabase/supabase-js";
import { composeHealth } from "../../_lib/analytics.js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { vendor_id: vu.vendor_id } : null;
  } catch { return null; }
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

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  // Live composition for "current"
  const now = new Date();
  const periodStart = new Date(now.getTime() - 180 * 86_400_000).toISOString().slice(0, 10);
  const periodEnd = now.toISOString().slice(0, 10);

  const [kpiRes, docTypesRes, docsRes, invRes, trendRes] = await Promise.all([
    admin.from("vendor_kpi_live").select("*").eq("vendor_id", caller.vendor_id).maybeSingle(),
    admin.from("compliance_document_types").select("id").eq("active", true).eq("required", true),
    admin.from("compliance_documents").select("document_type_id, status, expiry_date, uploaded_at").eq("vendor_id", caller.vendor_id),
    admin.from("invoices").select("status, due_date, paid_at").eq("vendor_id", caller.vendor_id),
    admin.from("vendor_health_scores").select("*").eq("vendor_id", caller.vendor_id).order("period_start", { ascending: false }).limit(4),
  ]);

  const kpi = kpiRes.data;
  const requiredIds = (docTypesRes.data || []).map((t) => t.id);
  const latestByType = new Map();
  for (const d of docsRes.data || []) {
    const p = latestByType.get(d.document_type_id);
    if (!p || new Date(d.uploaded_at) > new Date(p.uploaded_at)) latestByType.set(d.document_type_id, d);
  }
  let approvedDocs = 0;
  for (const tid of requiredIds) {
    const d = latestByType.get(tid);
    if (!d || d.status !== "approved") continue;
    if (d.expiry_date && new Date(d.expiry_date).getTime() < now.getTime()) continue;
    approvedDocs++;
  }

  const overdueInvoices = (invRes.data || []).filter((i) =>
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

  const trend = (trendRes.data || [])
    .slice()
    .sort((a, b) => new Date(a.period_start).getTime() - new Date(b.period_start).getTime())
    .map((r) => ({
      period_start: r.period_start,
      period_end: r.period_end,
      overall: Number(r.overall_score),
    }));

  return res.status(200).json({
    current: {
      period_start: periodStart,
      period_end: periodEnd,
      overall: comp.overall,
      delivery: comp.delivery,
      quality: comp.quality,
      compliance: comp.compliance,
      financial: comp.financial,
      responsiveness: comp.responsiveness,
      breakdown: comp,
    },
    trend,
  });
}
