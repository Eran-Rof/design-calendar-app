// api/internal/costing/search/colors
// GET ?q=<text>&style_code=<code>
//   → distinct color values from a union of sources, deduped + sorted.
//
// Sources, in order:
//   1. ip_item_master.color    — SKU master (Xoro nightly sync). Scoped to
//                                style_code when provided so the picker
//                                narrows to "this style comes in CHARCOAL,
//                                BLACK, STORMY WEATHER" instead of the
//                                entity-wide list.
//   2. costing_lines.color     — colors operators have typed on prior
//                                costing rows. This is the recovery path
//                                for entities whose ip_item_master is
//                                sparse / not yet synced — without it the
//                                dropdown would be empty until Xoro lands.
//                                NOT scoped by style_code (operator may
//                                want to reuse a color across styles).
//   3. app_data.costing_extra_colors — operator-added freeform extras
//                                saved via the picker's "+ Add new" button.
//                                Always global (suggestions, not constraints).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const styleCode = (url.searchParams.get("style_code") || "").trim();

  const seen = new Set();

  // 1. Distinct colors from ip_item_master (Xoro-synced SKU master).
  let itemQuery = admin.from("ip_item_master")
    .select("color")
    .not("color", "is", null)
    .range(0, 9999);
  if (styleCode) itemQuery = itemQuery.eq("style_code", styleCode);
  const { data: itemRows, error: itemErr } = await itemQuery;
  if (itemErr) return res.status(500).json({ error: itemErr.message });
  for (const r of itemRows || []) {
    if (r.color && typeof r.color === "string") seen.add(r.color.trim());
  }

  // 2. Colors typed on prior costing_lines. SCOPED to the same style when one
  // is provided — operator ask: a style's dropdown must show only that style's
  // colors (RYB187810 has one color, not every color ever typed on any style).
  // When no style is scoped, the full list is still offered as a fallback.
  try {
    let lineQuery = admin.from("costing_lines")
      .select("color")
      .not("color", "is", null)
      .range(0, 9999);
    if (styleCode) lineQuery = lineQuery.eq("style_code", styleCode);
    const { data: lineRows } = await lineQuery;
    for (const r of lineRows || []) {
      if (r.color && typeof r.color === "string") seen.add(r.color.trim());
    }
  } catch { /* non-fatal — falls back to source 1 */ }

  // 3. Operator-added freeform extras (app_data) — GLOBAL suggestions, so only
  // merged when NO style is scoped. With a style selected the dropdown reflects
  // that style's real colors; the picker's "+ Add new color" still lets the
  // operator add a one-off, which then re-surfaces via source 2 for this style.
  if (!styleCode) {
    try {
      const { data: extras } = await admin.from("app_data")
        .select("value").eq("key", "costing_extra_colors").maybeSingle();
      if (extras?.value) {
        const arr = typeof extras.value === "string" ? JSON.parse(extras.value) : extras.value;
        if (Array.isArray(arr)) for (const c of arr) if (typeof c === "string") seen.add(c.trim());
      }
    } catch { /* swallow */ }
  }

  let rows = Array.from(seen).filter(Boolean).sort();
  if (q) rows = rows.filter((c) => c.toLowerCase().includes(q));
  rows = rows.slice(0, 50);

  return res.status(200).json({ rows });
}
