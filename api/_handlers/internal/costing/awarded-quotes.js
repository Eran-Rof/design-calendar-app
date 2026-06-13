// api/internal/costing/awarded-quotes
//
// GET — the newest AWARDED RFQ quote(s) from the costing module, for the PO
// "Get PO price" flow. An award lives on a costing_line (status='awarded') whose
// selected_vendor_quote_id points at the winning costing_line_vendors row
// (the awarded price + vendor); the award timestamp is the latest
// costing_line_status_history row (status='awarded').
//
//   ?style_code=RYB0594        one style
//   ?style_codes=A,B,C         several styles (the SO's styles)
//   (none)                     all awarded styles, newest first
//
// Response: { quotes: [{ costing_line_id, project_id, style_code, vendor_id,
//   vendor_name, quoted_cost, currency, awarded_at, quoted_date }] }
// Multiple awards for the same style are all returned (newest first) so the UI
// can ask the operator which to use.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const one = (url.searchParams.get("style_code") || "").trim();
  const many = (url.searchParams.get("style_codes") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const codes = one ? [one] : many;

  // 1. Awarded costing lines (optionally filtered to the requested styles).
  let clQ = admin.from("costing_lines")
    .select("id, project_id, style_code, selected_vendor_quote_id, updated_at")
    .eq("status", "awarded")
    .not("selected_vendor_quote_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (codes.length) clQ = clQ.in("style_code", codes);
  const { data: lines, error: clErr } = await clQ;
  if (clErr) return res.status(500).json({ error: clErr.message });
  if (!lines || lines.length === 0) return res.status(200).json({ quotes: [] });

  // 2. The selected vendor quotes (awarded price + vendor).
  const quoteIds = [...new Set(lines.map((l) => l.selected_vendor_quote_id).filter(Boolean))];
  const { data: clvs } = await admin.from("costing_line_vendors")
    .select("id, vendor_id, quoted_cost, currency, quoted_date")
    .in("id", quoteIds);
  const clvById = new Map((clvs || []).map((q) => [q.id, q]));

  // 3. Vendor names.
  const vendorIds = [...new Set((clvs || []).map((q) => q.vendor_id).filter(Boolean))];
  const { data: vendors } = vendorIds.length
    ? await admin.from("vendors").select("id, name").in("id", vendorIds)
    : { data: [] };
  const vendorById = new Map((vendors || []).map((v) => [v.id, v]));

  // 4. Award timestamp = latest status_history 'awarded' row per line.
  const lineIds = lines.map((l) => l.id);
  const { data: hist } = await admin.from("costing_line_status_history")
    .select("costing_line_id, changed_at, status")
    .in("costing_line_id", lineIds)
    .eq("status", "awarded")
    .order("changed_at", { ascending: false });
  const awardedAtByLine = new Map();
  for (const h of hist || []) if (!awardedAtByLine.has(h.costing_line_id)) awardedAtByLine.set(h.costing_line_id, h.changed_at);

  const quotes = lines.map((l) => {
    const clv = clvById.get(l.selected_vendor_quote_id);
    if (!clv) return null;
    return {
      costing_line_id: l.id,
      project_id: l.project_id,
      style_code: l.style_code,
      vendor_id: clv.vendor_id,
      vendor_name: vendorById.get(clv.vendor_id)?.name || null,
      quoted_cost: clv.quoted_cost != null ? Number(clv.quoted_cost) : null,
      currency: clv.currency || "USD",
      awarded_at: awardedAtByLine.get(l.id) || l.updated_at || null,
      quoted_date: clv.quoted_date || null,
    };
  }).filter(Boolean);

  // Newest award first.
  quotes.sort((a, b) => String(b.awarded_at || "").localeCompare(String(a.awarded_at || "")));
  return res.status(200).json({ quotes });
}
