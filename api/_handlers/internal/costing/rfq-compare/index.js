// api/internal/costing/rfq-compare
//
// GET ?project_id=<uuid>
//
// Cross-RFQ vendor-quote comparison for ONE costing project. Returns every
// RFQ that was generated from the project (rfqs.source_costing_project_id =
// project_id), each with its line items and every SUBMITTED vendor quote
// (status in submitted/under_review/awarded — drafts excluded) plus the
// quote's per-line unit prices. The frontend (RfqCompareView) renders the
// comparison matrix and computes cheapest-per-line / deltas client-side.
//
// Shape:
//   { project: { id, name },
//     rfqs: [ {
//       id, code, title, status,
//       line_items: [ { id, line_index, description, quantity } ],
//       quotes:     [ { vendor_id, vendor_name, status, total_price,
//                       lead_time_days, valid_until, notes,
//                       lines: [ { rfq_line_item_id, unit_price, quantity, notes } ] } ]
//     } ] }

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 30 };

// Quote statuses considered "real" submissions (drafts are excluded so the
// matrix never compares against a half-entered quote).
const SUBMITTED_STATUSES = ["submitted", "under_review", "awarded"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const projectId = (url.searchParams.get("project_id") || "").trim();
  if (!projectId) return res.status(400).json({ error: "project_id is required" });

  // 1. Project header (name).
  const { data: project, error: projErr } = await admin
    .from("costing_projects")
    .select("id, project_name")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return res.status(500).json({ error: projErr.message });
  if (!project) return res.status(404).json({ error: "Project not found" });

  // 2. RFQs generated from this project. `code` is the newest column
  // (20260812000000_rfq_code.sql) — drop it on a pre-migration deploy so the
  // comparison still loads.
  const rfqCols = "id, code, title, status";
  let { data: rfqs, error: rfqsErr } = await admin
    .from("rfqs")
    .select(rfqCols)
    .eq("source_costing_project_id", projectId)
    .order("created_at", { ascending: true });
  if (rfqsErr && /column .* does not exist/i.test(rfqsErr.message || "") && /\bcode\b/.test(rfqsErr.message || "")) {
    ({ data: rfqs, error: rfqsErr } = await admin
      .from("rfqs")
      .select("id, title, status")
      .eq("source_costing_project_id", projectId)
      .order("created_at", { ascending: true }));
    if (rfqs) rfqs = rfqs.map((r) => ({ ...r, code: null }));
  }
  if (rfqsErr) return res.status(500).json({ error: rfqsErr.message });

  if (!rfqs || rfqs.length === 0) {
    return res.status(200).json({ project: { id: project.id, name: project.project_name }, rfqs: [] });
  }

  const rfqIds = rfqs.map((r) => r.id);

  // 3. Batched pulls: line items, quotes (+vendor), quote lines.
  const [itemsRes, quotesRes] = await Promise.all([
    admin.from("rfq_line_items")
      .select("id, rfq_id, line_index, description, quantity")
      .in("rfq_id", rfqIds)
      .order("line_index", { ascending: true }),
    admin.from("rfq_quotes")
      .select("id, rfq_id, vendor_id, status, total_price, lead_time_days, valid_until, notes, vendor:vendors(id, name, legal_name, code)")
      .in("rfq_id", rfqIds)
      .in("status", SUBMITTED_STATUSES),
  ]);
  if (itemsRes.error) return res.status(500).json({ error: itemsRes.error.message });
  if (quotesRes.error) return res.status(500).json({ error: quotesRes.error.message });

  const quotes = quotesRes.data || [];
  const quoteIds = quotes.map((q) => q.id);

  let quoteLines = [];
  if (quoteIds.length > 0) {
    const { data: ql, error: qlErr } = await admin
      .from("rfq_quote_lines")
      .select("quote_id, rfq_line_item_id, unit_price, quantity, notes")
      .in("quote_id", quoteIds);
    if (qlErr) return res.status(500).json({ error: qlErr.message });
    quoteLines = ql || [];
  }

  // 4. Group.
  const itemsByRfq = new Map();
  for (const it of itemsRes.data || []) {
    if (!itemsByRfq.has(it.rfq_id)) itemsByRfq.set(it.rfq_id, []);
    itemsByRfq.get(it.rfq_id).push({
      id: it.id,
      line_index: it.line_index,
      description: it.description,
      quantity: it.quantity,
    });
  }

  const linesByQuote = new Map();
  for (const l of quoteLines) {
    if (!linesByQuote.has(l.quote_id)) linesByQuote.set(l.quote_id, []);
    linesByQuote.get(l.quote_id).push({
      rfq_line_item_id: l.rfq_line_item_id,
      unit_price: l.unit_price,
      quantity: l.quantity,
      notes: l.notes,
    });
  }

  const quotesByRfq = new Map();
  for (const q of quotes) {
    const v = q.vendor || null;
    const vendorName = v?.legal_name || v?.name || v?.code || null;
    if (!quotesByRfq.has(q.rfq_id)) quotesByRfq.set(q.rfq_id, []);
    quotesByRfq.get(q.rfq_id).push({
      vendor_id: q.vendor_id,
      vendor_name: vendorName,
      status: q.status,
      total_price: q.total_price,
      lead_time_days: q.lead_time_days,
      valid_until: q.valid_until,
      notes: q.notes,
      lines: linesByQuote.get(q.id) || [],
    });
  }

  const out = rfqs.map((r) => ({
    id: r.id,
    code: r.code ?? null,
    title: r.title,
    status: r.status,
    line_items: itemsByRfq.get(r.id) || [],
    quotes: quotesByRfq.get(r.id) || [],
  }));

  return res.status(200).json({
    project: { id: project.id, name: project.project_name },
    rfqs: out,
  });
}
