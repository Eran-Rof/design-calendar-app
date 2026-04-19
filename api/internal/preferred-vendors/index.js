// api/internal/preferred-vendors
//
// GET — all preferred-vendor entries grouped by category, with each
// vendor's live health score + KPI snapshot attached so ops can see
// at a glance who's ranked where and how they're performing.
//
// Response:
//   {
//     categories: [
//       { category, vendors: [
//           { pref_id, rank, notes, set_by, vendor: {...},
//             health: { overall, delivery, quality, compliance,
//                       financial, responsiveness },
//             kpi: { on_time_delivery_pct, invoice_accuracy_pct,
//                    avg_acknowledgment_hours } }
//         ]  // sorted by rank asc
//       }
//     ]
//   }

import { createClient } from "@supabase/supabase-js";
import { composeHealth } from "../../_lib/analytics.js";

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

  const [prefRes, vRes, kpiRes, docTypesRes, docsRes, invRes] = await Promise.all([
    admin.from("preferred_vendors").select("*"),
    admin.from("vendors").select("id, name, status"),
    admin.from("vendor_kpi_live").select("vendor_id, on_time_delivery_pct, invoice_accuracy_pct, invoice_count, discrepancy_count, avg_acknowledgment_hours"),
    admin.from("compliance_document_types").select("id").eq("active", true).eq("required", true),
    admin.from("compliance_documents").select("vendor_id, document_type_id, status, expiry_date, uploaded_at"),
    admin.from("invoices").select("vendor_id, status, due_date"),
  ]);
  const errs = [prefRes, vRes, kpiRes, docTypesRes, docsRes, invRes].filter((r) => r.error);
  if (errs.length) return res.status(500).json({ error: errs[0].error.message });

  const vendorsById = new Map((vRes.data || []).map((v) => [v.id, v]));
  const kpiByVendor = new Map((kpiRes.data || []).map((k) => [k.vendor_id, k]));
  const requiredIds = (docTypesRes.data || []).map((t) => t.id);
  const now = new Date();

  const latestByVendor = new Map();
  for (const d of docsRes.data || []) {
    const key = `${d.vendor_id}|${d.document_type_id}`;
    const prev = latestByVendor.get(key);
    if (!prev || new Date(d.uploaded_at) > new Date(prev.uploaded_at)) latestByVendor.set(key, d);
  }

  function approvedDocCount(vendorId) {
    let n = 0;
    for (const tid of requiredIds) {
      const d = latestByVendor.get(`${vendorId}|${tid}`);
      if (!d || d.status !== "approved") continue;
      if (d.expiry_date && new Date(d.expiry_date).getTime() < now.getTime()) continue;
      n++;
    }
    return n;
  }

  const invByVendor = new Map();
  for (const i of invRes.data || []) {
    (invByVendor.get(i.vendor_id) || invByVendor.set(i.vendor_id, []).get(i.vendor_id)).push(i);
  }
  function overdueCount(vendorId) {
    return (invByVendor.get(vendorId) || []).filter((i) =>
      i.status !== "paid" && i.status !== "rejected" && i.due_date && new Date(i.due_date) < now
    ).length;
  }

  const byCategory = new Map();
  for (const p of prefRes.data || []) {
    const v = vendorsById.get(p.vendor_id);
    if (!v) continue;
    const kpi = kpiByVendor.get(p.vendor_id);
    const comp = composeHealth({
      on_time_delivery_pct: kpi?.on_time_delivery_pct,
      invoice_count: kpi?.invoice_count,
      discrepancy_count: kpi?.discrepancy_count,
      approved_docs: approvedDocCount(p.vendor_id),
      required_docs: requiredIds.length,
      overdue_invoices: overdueCount(p.vendor_id),
      avg_acknowledgment_hours: kpi?.avg_acknowledgment_hours,
    });

    const entry = {
      pref_id: p.id,
      rank: p.rank,
      notes: p.notes,
      set_by: p.set_by,
      created_at: p.created_at,
      vendor: { id: v.id, name: v.name, status: v.status || "active" },
      health: {
        overall: comp.overall, delivery: comp.delivery, quality: comp.quality,
        compliance: comp.compliance, financial: comp.financial, responsiveness: comp.responsiveness,
      },
      kpi: kpi ? {
        on_time_delivery_pct: kpi.on_time_delivery_pct == null ? null : Number(kpi.on_time_delivery_pct),
        invoice_accuracy_pct: kpi.invoice_accuracy_pct == null ? null : Number(kpi.invoice_accuracy_pct),
        avg_acknowledgment_hours: kpi.avg_acknowledgment_hours == null ? null : Number(kpi.avg_acknowledgment_hours),
      } : null,
    };
    const arr = byCategory.get(p.category) || [];
    arr.push(entry);
    byCategory.set(p.category, arr);
  }

  const categories = [...byCategory.entries()]
    .map(([category, vendors]) => ({
      category,
      vendors: vendors.sort((a, b) => (a.rank || 99) - (b.rank || 99)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

  return res.status(200).json({ categories });
}
