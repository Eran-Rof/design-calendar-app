// api/internal/three-way-match/matches
//
// 3-Way Match module — GET the bill-grain match results (ap_bill_matches
// joined to invoices + vendors) plus a status summary (counts + $).
//
// Query params (all optional):
//   status=<match status>   resolution=<open|accepted|disputed>
//   vendor=<substring>      from=<yyyy-mm-dd>  to=<yyyy-mm-dd>
//
// The summary is computed over the FILTER-INDEPENDENT full population so the
// tiles always show the whole book; the rows honor the filters. Everything is
// paged past the PostgREST 1000-row cap and aggregated server-side.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 60 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function pageAll(query) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const q = req.query || {};
  const status = (q.status || "").toString().trim();
  const resolution = (q.resolution || "").toString().trim();
  const vendor = (q.vendor || "").toString().trim().toLowerCase();
  const from = (q.from || "").toString().trim();
  const to = (q.to || "").toString().trim();

  try {
    const matches = await pageAll((a, b) =>
      admin
        .from("ap_bill_matches")
        .select("id, bill_id, status, method, po_refs, variance, matched_at, engine_version, resolution, resolution_reason, resolved_by, resolved_at")
        .order("matched_at", { ascending: false })
        .range(a, b));

    // Bill headers for every match row (paged .in() batches of 200).
    const billIds = matches.map((m) => m.bill_id);
    const bills = new Map();
    for (let i = 0; i < billIds.length; i += 200) {
      const chunk = billIds.slice(i, i + 200);
      const { data, error } = await admin
        .from("invoices")
        .select("id, invoice_number, invoice_date, total_amount_cents, vendor_id, gl_status, source")
        .in("id", chunk)
        .range(0, 999);
      if (error) throw new Error(error.message);
      for (const b of data || []) bills.set(b.id, b);
    }

    const vendorIds = [...new Set([...bills.values()].map((b) => b.vendor_id).filter(Boolean))];
    const vendors = new Map();
    for (let i = 0; i < vendorIds.length; i += 200) {
      const chunk = vendorIds.slice(i, i + 200);
      const { data, error } = await admin
        .from("vendors").select("id, name").in("id", chunk).range(0, 999);
      if (error) throw new Error(error.message);
      for (const v of data || []) vendors.set(v.id, v.name);
    }

    const all = matches.map((m) => {
      const b = bills.get(m.bill_id) || {};
      return {
        ...m,
        invoice_number: b.invoice_number || null,
        invoice_date: b.invoice_date || null,
        total_amount_cents: Number(b.total_amount_cents || 0),
        vendor_id: b.vendor_id || null,
        vendor_name: vendors.get(b.vendor_id) || null,
        po_numbers: Array.isArray(m.po_refs) ? m.po_refs.map((r) => r.po_number).filter(Boolean) : [],
      };
    });

    // Filter-independent summary (counts + $ by status, plus open-exception cut)
    const summary = {};
    for (const r of all) {
      const s = (summary[r.status] ||= { n: 0, cents: 0, open_n: 0, open_cents: 0 });
      s.n += 1; s.cents += r.total_amount_cents;
      if (r.resolution === "open") { s.open_n += 1; s.open_cents += r.total_amount_cents; }
    }

    let rows = all;
    if (status) rows = rows.filter((r) => r.status === status);
    if (resolution) rows = rows.filter((r) => r.resolution === resolution);
    if (vendor) rows = rows.filter((r) => (r.vendor_name || "").toLowerCase().includes(vendor));
    if (from) rows = rows.filter((r) => r.invoice_date && r.invoice_date >= from);
    if (to) rows = rows.filter((r) => r.invoice_date && r.invoice_date <= to);

    const lastRun = all.reduce((acc, r) => (r.matched_at > acc ? r.matched_at : acc), "");
    return res.status(200).json({ summary, rows, total: all.length, last_run: lastRun || null });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
