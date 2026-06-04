// api/internal/prepack-matrices/needed
//
// GET → every PPK style that still needs a prepack matrix (from
// v_prepack_ppk_needed), with the MASTER style name, pack token, carton total
// (the PPKnn number), and the sized-sibling sizes ordered numeric / alpha
// (xs<s<m<l<xl<xxl<xxxl). Drives the panel's "Download all PPK" bulk template.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

const ALPHA = ["XXS","XS","XSM","S","SM","SML","SMALL","M","MED","MEDIUM","L","LG","LRG","LARGE","XL","XLG","XLARGE","XXL","2XL","XXXL","3XL","XXXXL","4XL","OS","ONE SIZE"];
const isNum = (s) => /^\d+(\.\d+)?$/.test(String(s).trim());
const arank = (s) => { const i = ALPHA.indexOf(String(s).toUpperCase().trim()); return i < 0 ? 999 : i; };
function cmpSize(a, b) {
  const an = isNum(a), bn = isNum(b);
  if (an && bn) return Number(a) - Number(b);
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  const ar = arank(a), br = arank(b);
  return ar !== br ? ar - br : String(a).localeCompare(String(b));
}
const cartonOf = (tok) => { const m = String(tok || "").match(/(\d+)/); return m ? Number(m[1]) : null; };

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data, error } = await admin.from("v_prepack_ppk_needed").select("ppk_style_code, base_code, pack_token, style_name, sizes, size_scale_id, scale_code, scale_name, scale_sizes");
  if (error) return res.status(500).json({ error: error.message });

  const rows = (data || []).map((r) => ({
    ppk_style_code: r.ppk_style_code,
    style_name: r.style_name || "",                 // from master; "" if unknown
    pack_token: r.pack_token || null,
    carton_total: cartonOf(r.pack_token),
    sizes: Array.isArray(r.sizes) ? [...new Set(r.sizes.filter(Boolean))].sort(cmpSize) : [],
    // Assigned size scale (base style). scale_sizes preserves the operator-defined
    // ORDER from the size_scales master — do NOT re-sort it.
    size_scale_id: r.size_scale_id || null,
    scale_code: r.scale_code || null,
    scale_name: r.scale_name || null,
    scale_sizes: Array.isArray(r.scale_sizes) ? r.scale_sizes.filter(Boolean) : [],
  })).sort((a, b) => a.ppk_style_code.localeCompare(b.ppk_style_code));

  return res.status(200).json(rows);
}
