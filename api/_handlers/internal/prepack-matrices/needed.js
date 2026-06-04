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
const arank = (s) => { const i = ALPHA.indexOf(String(s).toUpperCase().trim()); return i < 0 ? 999 : i; };
// Sort key: [class, value, raw]. Class 0 = number-bearing (pure numeric, numeric-
// leading like 2T/12M, OR combined like "L/12" — sort by the NUMBER, e.g. S/8 <
// M/10 < L/12 < XL/14, never by the letter); class 1 = known alpha size (S<M<L…,
// so 2XL stays after XL rather than reading as "2"); class 2 = unknown.
function sizeKey(s) {
  const t = String(s).toUpperCase().trim();
  if (t.includes("/")) { const m = t.match(/\d+(\.\d+)?/); return [0, m ? Number(m[0]) : 999, t]; }
  const ar = arank(t);
  if (ar !== 999) return [1, ar, t];
  const m = t.match(/\d+(\.\d+)?/);
  if (m) return [0, Number(m[0]), t];
  return [2, 999, t];
}
function cmpSize(a, b) {
  const ka = sizeKey(a), kb = sizeKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
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
