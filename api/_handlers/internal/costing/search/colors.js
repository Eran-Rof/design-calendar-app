// api/internal/costing/search/colors
// GET ?q=<text>  → distinct color values from ip_item_master, plus any
// operator-added colors from app_data["costing_extra_colors"].
//
// Operator can free-type any color in the grid cell; this endpoint just
// powers the autocomplete suggestions.

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

  // 1. Distinct colors from ip_item_master (server-side dedupe via Set).
  const { data: itemRows, error: itemErr } = await admin.from("ip_item_master")
    .select("color")
    .not("color", "is", null)
    .range(0, 9999);
  if (itemErr) return res.status(500).json({ error: itemErr.message });

  const seen = new Set();
  for (const r of itemRows || []) {
    if (r.color && typeof r.color === "string") seen.add(r.color.trim());
  }

  // 2. Operator-added extras from app_data.
  try {
    const { data: extras } = await admin.from("app_data")
      .select("value").eq("key", "costing_extra_colors").maybeSingle();
    if (extras?.value) {
      const arr = typeof extras.value === "string" ? JSON.parse(extras.value) : extras.value;
      if (Array.isArray(arr)) for (const c of arr) if (typeof c === "string") seen.add(c.trim());
    }
  } catch { /* swallow */ }

  let rows = Array.from(seen).filter(Boolean).sort();
  if (q) rows = rows.filter((c) => c.toLowerCase().includes(q));
  rows = rows.slice(0, 50);

  return res.status(200).json({ rows });
}
