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
//       line_items: [ { id, line_index, description, quantity, sell_price } ],
//       quotes:     [ { vendor_id, vendor_name, status, total_price,
//                       lead_time_days, valid_until, notes,
//                       lines: [ { rfq_line_item_id, unit_price, quantity, notes } ] } ]
//     } ] }
//
// `sell_price` per line is the reference sell price resolved from the source costing
// line. Resolution priority: (1) costing_line_id FK → costing_lines.sell_price /
// sell_target / target_cost; (2) style_code:color match within the project;
// (3) target_cost value match using rfq_line_items.target_price as a lookup key
// (covers RFQs generated before the style_code/color columns existed). NULL when no
// match is found. The frontend computes per-vendor margin = (sell − quoted) / sell.

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
  const debugMode = url.searchParams.get("debug") === "1";
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

  // 3. Batched pulls: line items + quotes (+vendor).
  // style_code + color on rfq_line_items are used as the fallback join key when
  // costing_line_id is null (older RFQs generated before migration 20260719000000).
  let [itemsRes, quotesRes] = await Promise.all([
    admin.from("rfq_line_items")
      .select("id, rfq_id, line_index, description, quantity, costing_line_id, target_price, style_code, color")
      .in("rfq_id", rfqIds)
      .order("line_index", { ascending: true }),
    admin.from("rfq_quotes")
      .select("id, rfq_id, vendor_id, status, total_price, lead_time_days, valid_until, notes, vendor:vendors(id, name, legal_name, code)")
      .in("rfq_id", rfqIds)
      .in("status", SUBMITTED_STATUSES),
  ]);
  if (itemsRes.error) return res.status(500).json({ error: itemsRes.error.message });
  if (quotesRes.error) return res.status(500).json({ error: quotesRes.error.message });

  // Helper: coerce numeric(12,4) which Supabase may return as a string or number.
  const toNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

  // 3b. Resolve the current sell/target prices from costing_lines for this project.
  // Three lookup paths — use whichever is available:
  //   A. costing_line_id (exact FK) — preferred, always current
  //   B. style_code:color match within the project — fallback for rows where
  //      costing_line_id is null (RFQ generated before migration 20260719000000)
  //   C. target_cost value match — last resort for rows where style_code/color are
  //      also null (RFQ generated before migration 20260713060000). The snapshot
  //      rfq_line_items.target_price equals costing_lines.target_cost at generation
  //      time, so matching on that value retrieves the current costing line and its
  //      sell_target even when no other identifier is available.
  const sellById = new Map();         // costing_line.id → resolved sell price
  const sellByStyleColor = new Map(); // "style_code:color" → resolved sell price
  const sellByTargetCost = new Map(); // String(target_cost) → resolved sell price

  const { data: clRows } = await admin
    .from("costing_lines")
    .select("id, style_code, color, sell_price, sell_target, target_cost")
    .eq("project_id", projectId);

  for (const cl of clRows || []) {
    // Priority per line: sell_price → sell_target → target_cost
    const sp = toNum(cl.sell_price) ?? toNum(cl.sell_target) ?? toNum(cl.target_cost) ?? null;
    if (sp !== null) {
      sellById.set(cl.id, sp);
      const scKey = `${cl.style_code || ""}:${cl.color || ""}`;
      if (!sellByStyleColor.has(scKey)) sellByStyleColor.set(scKey, sp);
      const tcKey = String(toNum(cl.target_cost) ?? "");
      if (tcKey && !sellByTargetCost.has(tcKey)) sellByTargetCost.set(tcKey, sp);
    }
  }

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
    // Sell price resolution — five-level fallback:
    // 1. Exact costing_line_id FK → current value from costing_lines
    // 2. style_code:color match within project → current value from costing_lines
    // 3. target_cost value match (target_price snapshot = costing_lines.target_cost) →
    //    current sell_target even when style/color are null on older rfq rows
    // 4. rfq_line_items.target_price snapshot (stale, only when all else fails)
    // 5. null
    const scKey = `${it.style_code || ""}:${it.color || ""}`;
    const tpKey = String(toNum(it.target_price) ?? "");
    const sell =
      (it.costing_line_id ? sellById.get(it.costing_line_id) : null) ??
      sellByStyleColor.get(scKey) ??
      (tpKey ? sellByTargetCost.get(tpKey) : null) ??
      toNum(it.target_price) ??
      null;
    itemsByRfq.get(it.rfq_id).push({
      id: it.id,
      line_index: it.line_index,
      description: it.description,
      quantity: it.quantity,
      sell_price: sell,
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

  if (debugMode) {
    // Raw DB values for diagnosing sell_price resolution. Never shown in prod UI.
    return res.status(200).json({
      _debug: true,
      project: { id: project.id, name: project.project_name },
      costing_lines: (clRows || []).map((cl) => ({
        id: cl.id,
        style_code: cl.style_code,
        color: cl.color,
        sell_price: cl.sell_price,
        sell_target: cl.sell_target,
        target_cost: cl.target_cost,
        _resolved_sp: toNum(cl.sell_price) ?? toNum(cl.sell_target) ?? toNum(cl.target_cost) ?? null,
      })),
      rfq_line_items: (itemsRes.data || []).map((it) => {
        const scKey = `${it.style_code || ""}:${it.color || ""}`;
        const tpKey = String(toNum(it.target_price) ?? "");
        const step1 = it.costing_line_id ? (sellById.get(it.costing_line_id) ?? null) : null;
        const step2 = sellByStyleColor.get(scKey) ?? null;
        const step3 = tpKey ? (sellByTargetCost.get(tpKey) ?? null) : null;
        const step4 = toNum(it.target_price) ?? null;
        return {
          id: it.id,
          rfq_id: it.rfq_id,
          line_index: it.line_index,
          costing_line_id: it.costing_line_id ?? null,
          style_code: it.style_code ?? null,
          color: it.color ?? null,
          target_price: it.target_price ?? null,
          _scKey: scKey,
          _tpKey: tpKey,
          _step1_fk: step1,
          _step2_style_color: step2,
          _step3_target_cost: step3,
          _step4_snapshot: step4,
          _resolved: step1 ?? step2 ?? step3 ?? step4 ?? null,
        };
      }),
    });
  }

  return res.status(200).json({
    project: { id: project.id, name: project.project_name },
    rfqs: out,
  });
}
