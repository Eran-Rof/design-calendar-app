// api/internal/pim/style-colors
//
// GET — bulk (style_code → distinct colors) map sourced from ip_item_master
//        (the color-grain SKU master synced nightly from Xoro). Used by the
//        PIM Product Catalog to expand each style into one row per color
//        WITHOUT N+1 per-style matrix calls.
//
//        Query: ?q=<text>  — optional filter; keeps pairs whose style_code
//                            OR color contains the text (case-insensitive).
//        Returns: [{ style_code, color }]
//          - One entry per distinct (style_code, color). Colors are trimmed
//            and de-duped per style (case-insensitive). Sorted by
//            (style_code, color).
//
// ip_item_master has no image column, so the catalog reuses the style's
// PIM primary thumb for every color row (color-level imagery lives in PIM,
// not the SKU master). This endpoint stays a lean style→color map.
//
// Internal handlers read req.query.id; this one only needs ?q so we parse
// the URL directly like the sibling costing/search/colors handler.
//
// Tangerine PIM — Product Catalog by style × color.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 20 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();

  // Walk ip_item_master in pages (PostgREST caps page size ~1000) to collect
  // every (style_code, color) pair across the whole entity. The cheap two-col
  // projection keeps the payload small even for large masters.
  const PAGE = 1000;
  // style_code -> Map<colorKeyLower, colorOriginal>
  const byStyle = new Map();
  let from = 0;
  // Hard ceiling so a runaway master can't loop forever (~50k rows).
  for (let page = 0; page < 50; page++) {
    const { data, error } = await admin
      .from("ip_item_master")
      .select("style_code, color")
      .not("style_code", "is", null)
      .order("style_code", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) break;
    for (const r of data) {
      const sc = (r.style_code || "").trim();
      if (!sc) continue;
      const color = (r.color || "").trim();
      if (!color) continue;
      const key = color.toLowerCase();
      let colors = byStyle.get(sc);
      if (!colors) { colors = new Map(); byStyle.set(sc, colors); }
      if (!colors.has(key)) colors.set(key, color);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const out = [];
  for (const [style_code, colors] of byStyle) {
    for (const color of colors.values()) {
      if (q && !style_code.toLowerCase().includes(q) && !color.toLowerCase().includes(q)) continue;
      out.push({ style_code, color });
    }
  }
  out.sort((a, b) =>
    a.style_code === b.style_code
      ? a.color.localeCompare(b.color)
      : a.style_code.localeCompare(b.style_code));

  return res.status(200).json(out);
}
