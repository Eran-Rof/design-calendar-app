// api/internal/reports/vendors.js
//
// GET — cross-vendor summary (internal).
//   ?status=<active|inactive>
//   ?compliance_complete=true
//
// Each row:
//   { vendor_id, name, active_po_count, open_invoice_count,
//     total_invoiced_open, total_paid_ytd,
//     compliance_status: { complete, missing, expiring_soon, rejected },
//     compliance_complete: boolean,
//     scorecard: { on_time_delivery_pct, invoice_accuracy_pct,
//                  avg_acknowledgment_hours, composite_score } }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

function composite(ot, acc, ack) {
  if (ot == null && acc == null && ack == null) return null;
  const ackScore = ack == null ? 50 : Math.max(0, Math.min(100, 100 - (ack - 24) * 100 / 48));
  return Math.round(((ot ?? 0) * 0.5 + (acc ?? 0) * 0.4 + ackScore * 0.1) * 10) / 10;
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
  const onlyComplianceComplete = url.searchParams.get("compliance_complete") === "true";

  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();

  const [vRes, kpiRes, posRes, invRes, docTypesRes, docsRes] = await Promise.all([
    admin.from("vendors").select("id, name, deleted_at"),
    admin.from("vendor_kpi_live").select("vendor_id, on_time_delivery_pct, invoice_accuracy_pct, avg_acknowledgment_hours"),
    admin.from("tanda_pos").select("vendor_id, data"),
    admin.from("invoices").select("vendor_id, status, total, submitted_at, paid_at"),
    admin.from("compliance_document_types").select("id, required, expiry_required").eq("active", true),
    admin.from("compliance_documents").select("vendor_id, document_type_id, status, expiry_date, uploaded_at"),
  ]);

  if (vRes.error)        return res.status(500).json({ error: vRes.error.message });
  if (kpiRes.error)      return res.status(500).json({ error: kpiRes.error.message });
  if (posRes.error)      return res.status(500).json({ error: posRes.error.message });
  if (invRes.error)      return res.status(500).json({ error: invRes.error.message });
  if (docTypesRes.error) return res.status(500).json({ error: docTypesRes.error.message });
  if (docsRes.error)     return res.status(500).json({ error: docsRes.error.message });

  const vendors = (vRes.data || []).filter((v) => !v.deleted_at);
  const kpiByVendor = new Map((kpiRes.data || []).map((k) => [k.vendor_id, k]));
  const allPos = posRes.data || [];
  const allInv = invRes.data || [];
  const types = docTypesRes.data || [];
  const allDocs = docsRes.data || [];

  const now = new Date();
  const in60 = new Date(now.getTime() + 60 * 86_400_000);

  const rows = vendors.map((v) => {
    const vposs = allPos.filter((p) => p.vendor_id === v.id && !p.data?._archived);
    const activePo = vposs.filter((p) => !((p.data?.StatusName || "").toLowerCase().includes("closed"))).length;

    const vinv = allInv.filter((i) => i.vendor_id === v.id);
    const openInv = vinv.filter((i) => !["paid", "rejected"].includes(i.status));
    const totalInvoicedOpen = openInv.reduce((a, i) => a + (Number(i.total) || 0), 0);
    const totalPaidYtd = vinv
      .filter((i) => i.status === "paid" && i.paid_at && new Date(i.paid_at).toISOString() >= yearStart)
      .reduce((a, i) => a + (Number(i.total) || 0), 0);

    // Compliance grouping (latest doc per type)
    const vdocs = allDocs.filter((d) => d.vendor_id === v.id);
    const latestByType = new Map();
    for (const d of vdocs) {
      const prev = latestByType.get(d.document_type_id);
      if (!prev || new Date(d.uploaded_at) > new Date(prev.uploaded_at)) latestByType.set(d.document_type_id, d);
    }
    let complete = 0, missing = 0, expiring_soon = 0, rejected = 0;
    for (const t of types) {
      const d = latestByType.get(t.id);
      if (!d) { if (t.required) missing++; continue; }
      if (d.status === "rejected") { rejected++; continue; }
      if (d.status === "approved" && d.expiry_date) {
        const exp = new Date(d.expiry_date);
        if (exp < now) { if (t.required) missing++; continue; }
        if (exp < in60) { expiring_soon++; continue; }
      }
      if (d.status === "approved" || d.status === "pending_review") complete++;
      else if (d.status === "expired") { if (t.required) missing++; }
    }
    const compliance_complete = missing === 0 && rejected === 0;

    const kpi = kpiByVendor.get(v.id);
    const scorecard = {
      on_time_delivery_pct: kpi?.on_time_delivery_pct ?? null,
      invoice_accuracy_pct: kpi?.invoice_accuracy_pct ?? null,
      avg_acknowledgment_hours: kpi?.avg_acknowledgment_hours ?? null,
      composite_score: composite(kpi?.on_time_delivery_pct, kpi?.invoice_accuracy_pct, kpi?.avg_acknowledgment_hours),
    };

    return {
      vendor_id: v.id,
      name: v.name,
      active_po_count: activePo,
      open_invoice_count: openInv.length,
      total_invoiced_open: Math.round(totalInvoicedOpen * 100) / 100,
      total_paid_ytd: Math.round(totalPaidYtd * 100) / 100,
      compliance_status: { complete, missing, expiring_soon, rejected },
      compliance_complete,
      scorecard,
    };
  });

  const filtered = onlyComplianceComplete ? rows.filter((r) => r.compliance_complete) : rows;
  filtered.sort((a, b) => (b.scorecard.composite_score ?? -1) - (a.scorecard.composite_score ?? -1));
  return res.status(200).json(filtered);
}
