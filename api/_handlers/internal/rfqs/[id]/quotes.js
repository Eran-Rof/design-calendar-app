// api/internal/rfqs/:id/quotes
//
// GET — all submitted quotes for this RFQ with vendor name, total, lead
// time, and live health score. Sortable via ?sort=price|lead_time|health.

import { createClient } from "@supabase/supabase-js";
import { composeHealth } from "../../../../_lib/analytics.js";

export const config = { maxDuration: 30 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const qIdx = parts.lastIndexOf("quotes");
  return qIdx > 0 ? parts[qIdx - 1] : null;
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

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing rfq id" });
  const url = new URL(req.url, `https://${req.headers.host}`);
  const sort = (url.searchParams.get("sort") || "price").toLowerCase();

  const [quotesRes, linesRes] = await Promise.all([
    admin.from("rfq_quotes").select("*, vendor:vendors(id, name, status)").eq("rfq_id", id),
    admin.from("rfq_quote_lines").select("*"),
  ]);
  if (quotesRes.error) return res.status(500).json({ error: quotesRes.error.message });

  const vendorIds = [...new Set((quotesRes.data || []).map((q) => q.vendor_id))];
  const [kpiRes, docTypesRes, docsRes, invRes] = await Promise.all([
    admin.from("vendor_kpi_live").select("*").in("vendor_id", vendorIds),
    admin.from("compliance_document_types").select("id").eq("active", true).eq("required", true),
    admin.from("compliance_documents").select("vendor_id, document_type_id, status, expiry_date, uploaded_at").in("vendor_id", vendorIds),
    admin.from("invoices").select("vendor_id, status, due_date").in("vendor_id", vendorIds),
  ]);

  const kpiByVendor = new Map((kpiRes.data || []).map((k) => [k.vendor_id, k]));
  const requiredIds = (docTypesRes.data || []).map((t) => t.id);
  const now = new Date();
  const latestByVendor = new Map();
  for (const d of docsRes.data || []) {
    const key = `${d.vendor_id}|${d.document_type_id}`;
    const prev = latestByVendor.get(key);
    if (!prev || new Date(d.uploaded_at) > new Date(prev.uploaded_at)) latestByVendor.set(key, d);
  }
  const overdueByVendor = new Map();
  for (const i of invRes.data || []) {
    if (i.status !== "paid" && i.status !== "rejected" && i.due_date && new Date(i.due_date) < now) {
      overdueByVendor.set(i.vendor_id, (overdueByVendor.get(i.vendor_id) || 0) + 1);
    }
  }

  const linesByQuote = new Map();
  for (const l of linesRes.data || []) {
    const arr = linesByQuote.get(l.quote_id) || [];
    arr.push(l);
    linesByQuote.set(l.quote_id, arr);
  }

  const rows = (quotesRes.data || []).map((q) => {
    const kpi = kpiByVendor.get(q.vendor_id);
    let approved = 0;
    for (const tid of requiredIds) {
      const d = latestByVendor.get(`${q.vendor_id}|${tid}`);
      if (!d || d.status !== "approved") continue;
      if (d.expiry_date && new Date(d.expiry_date).getTime() < now.getTime()) continue;
      approved++;
    }
    const comp = composeHealth({
      on_time_delivery_pct: kpi?.on_time_delivery_pct,
      invoice_count: kpi?.invoice_count,
      discrepancy_count: kpi?.discrepancy_count,
      approved_docs: approved,
      required_docs: requiredIds.length,
      overdue_invoices: overdueByVendor.get(q.vendor_id) || 0,
      avg_acknowledgment_hours: kpi?.avg_acknowledgment_hours,
    });
    return {
      ...q,
      lines: linesByQuote.get(q.id) || [],
      vendor_name: q.vendor?.name || null,
      health_score: comp.overall,
    };
  });

  rows.sort((a, b) => {
    if (sort === "price")      return (a.total_price ?? Infinity) - (b.total_price ?? Infinity);
    if (sort === "lead_time")  return (a.lead_time_days ?? Infinity) - (b.lead_time_days ?? Infinity);
    if (sort === "health")     return (b.health_score ?? -1) - (a.health_score ?? -1);
    return 0;
  });

  return res.status(200).json(rows);
}
