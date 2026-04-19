// api/internal/vendors
//
// GET — cross-vendor directory for the internal vendor-management UI.
//
// Query params:
//   ?status=active|inactive
//   ?compliance_complete=true|false
//   ?has_open_flags=true
//   ?has_open_disputes=true
//   ?sort=name|spend_ytd|scorecard   (default: name)
//
// Each row:
//   {
//     id, name, status, payment_terms, tax_id,
//     active_po_count, open_invoice_count,
//     compliance_complete: boolean,
//     open_disputes: int,
//     open_flags: int,
//     latest_scorecard: { on_time_pct, accuracy_pct, composite },
//     contract_status: "none" | "active" | "expiring_soon" | "expired",
//     spend_ytd: number,
//   }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 60 };

function composite(ot, acc, ackHours) {
  if (ot == null && acc == null && ackHours == null) return null;
  const ackScore = ackHours == null ? 50 : Math.max(0, Math.min(100, 100 - (ackHours - 24) * 100 / 48));
  return Math.round(((ot ?? 0) * 0.5 + (acc ?? 0) * 0.4 + ackScore * 0.1) * 10) / 10;
}

function contractBucket(contracts, now) {
  if (!contracts || contracts.length === 0) return "none";
  const soonMs = now.getTime() + 30 * 86_400_000;
  let hasActive = false, hasSoon = false;
  for (const c of contracts) {
    if (c.status !== "signed") continue;
    const end = c.end_date ? new Date(c.end_date).getTime() : null;
    if (!end || end > soonMs) { hasActive = true; continue; }
    if (end >= now.getTime()) hasSoon = true;
  }
  if (hasActive) return "active";
  if (hasSoon)   return "expiring_soon";
  return "expired";
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
  const filterStatus     = url.searchParams.get("status");
  const filterCompliance = url.searchParams.get("compliance_complete");
  const filterOpenFlags  = url.searchParams.get("has_open_flags") === "true";
  const filterOpenDisp   = url.searchParams.get("has_open_disputes") === "true";
  const sort             = (url.searchParams.get("sort") || "name").toLowerCase();

  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
  const now = new Date();

  const [vRes, kpiRes, posRes, invRes, docTypesRes, docsRes, disRes, flagRes, contractRes] = await Promise.all([
    admin.from("vendors").select("id, name, status, payment_terms, tax_id, deleted_at"),
    admin.from("vendor_kpi_live").select("vendor_id, on_time_delivery_pct, invoice_accuracy_pct, avg_acknowledgment_hours"),
    admin.from("tanda_pos").select("vendor_id, data"),
    admin.from("invoices").select("vendor_id, status, total, paid_at"),
    admin.from("compliance_document_types").select("id, required").eq("active", true),
    admin.from("compliance_documents").select("vendor_id, document_type_id, status, expiry_date, uploaded_at"),
    admin.from("disputes").select("vendor_id, status"),
    admin.from("vendor_flags").select("vendor_id, status"),
    admin.from("contracts").select("vendor_id, status, end_date"),
  ]);

  const errs = [vRes, kpiRes, posRes, invRes, docTypesRes, docsRes, disRes, flagRes, contractRes].filter((r) => r.error);
  if (errs.length) return res.status(500).json({ error: errs[0].error.message });

  const vendors = (vRes.data || []).filter((v) => !v.deleted_at);
  const kpiByVendor = new Map((kpiRes.data || []).map((k) => [k.vendor_id, k]));
  const requiredTypes = (docTypesRes.data || []).filter((t) => t.required).map((t) => t.id);

  const rows = vendors.map((v) => {
    const vposs = (posRes.data || []).filter((p) => p.vendor_id === v.id && !p.data?._archived);
    const activePo = vposs.filter((p) => !((p.data?.StatusName || "").toLowerCase().includes("closed"))).length;

    const vinv = (invRes.data || []).filter((i) => i.vendor_id === v.id);
    const openInv = vinv.filter((i) => !["paid", "rejected"].includes(i.status)).length;
    const spendYtd = vinv
      .filter((i) => i.status === "paid" && i.paid_at && new Date(i.paid_at).toISOString() >= yearStart)
      .reduce((a, i) => a + (Number(i.total) || 0), 0);

    // Compliance — only the latest document per type counts
    const vdocs = (docsRes.data || []).filter((d) => d.vendor_id === v.id);
    const latestByType = new Map();
    for (const d of vdocs) {
      const prev = latestByType.get(d.document_type_id);
      if (!prev || new Date(d.uploaded_at) > new Date(prev.uploaded_at)) latestByType.set(d.document_type_id, d);
    }
    let complianceComplete = true;
    for (const tid of requiredTypes) {
      const d = latestByType.get(tid);
      if (!d || d.status !== "approved") { complianceComplete = false; break; }
      if (d.expiry_date && new Date(d.expiry_date).getTime() < now.getTime()) { complianceComplete = false; break; }
    }

    const openDisputes = (disRes.data || []).filter((d) => d.vendor_id === v.id && !["resolved", "closed"].includes(d.status)).length;
    const openFlags    = (flagRes.data || []).filter((f) => f.vendor_id === v.id && f.status === "open").length;
    const vcontracts   = (contractRes.data || []).filter((c) => c.vendor_id === v.id);
    const contractStatus = contractBucket(vcontracts, now);

    const k = kpiByVendor.get(v.id);
    const latestScorecard = k ? {
      on_time_pct: k.on_time_delivery_pct == null ? null : Number(k.on_time_delivery_pct),
      accuracy_pct: k.invoice_accuracy_pct == null ? null : Number(k.invoice_accuracy_pct),
      composite: composite(k.on_time_delivery_pct, k.invoice_accuracy_pct, k.avg_acknowledgment_hours),
    } : null;

    return {
      id: v.id,
      name: v.name,
      status: v.status || "active",
      payment_terms: v.payment_terms || null,
      tax_id: v.tax_id || null,
      active_po_count: activePo,
      open_invoice_count: openInv,
      compliance_complete: complianceComplete,
      open_disputes: openDisputes,
      open_flags: openFlags,
      latest_scorecard: latestScorecard,
      contract_status: contractStatus,
      spend_ytd: spendYtd,
    };
  });

  // Filters
  let filtered = rows;
  if (filterStatus) filtered = filtered.filter((r) => r.status === filterStatus);
  if (filterCompliance === "true")  filtered = filtered.filter((r) => r.compliance_complete);
  if (filterCompliance === "false") filtered = filtered.filter((r) => !r.compliance_complete);
  if (filterOpenFlags) filtered = filtered.filter((r) => r.open_flags > 0);
  if (filterOpenDisp)  filtered = filtered.filter((r) => r.open_disputes > 0);

  // Sort
  filtered.sort((a, b) => {
    if (sort === "spend_ytd")  return (b.spend_ytd || 0) - (a.spend_ytd || 0);
    if (sort === "scorecard")  return (b.latest_scorecard?.composite ?? -1) - (a.latest_scorecard?.composite ?? -1);
    return a.name.localeCompare(b.name);
  });

  return res.status(200).json(filtered);
}
