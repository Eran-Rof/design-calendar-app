// api/internal/states
//
// GET  — list state_master rows. Filters:
//          ?country=<iso2>     (e.g. US, CA — restrict to that country)
//          ?q=<search>         ilike on code or name
//          ?include_inactive=true  (default: active only)
//        Ordered country_iso2, sort_order, name.
//
// State / province reference data for the address dropdowns. state_master is
// GLOBAL (entity-agnostic), so no entity_id scope. Mirrors the countries handler.
// Read-only here (the seed list is comprehensive); rows are managed by migration.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const country = (url.searchParams.get("country") || "").trim().toUpperCase();
    const q = (url.searchParams.get("q") || "").trim();
    const includeInactive = url.searchParams.get("include_inactive") === "true";

    let query = admin
      .from("state_master")
      .select("*")
      .order("country_iso2", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (country) query = query.eq("country_iso2", country);
    if (!includeInactive) query = query.eq("is_active", true);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`code.ilike.%${esc}%,name.ilike.%${esc}%`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  res.setHeader("Allow", "GET");
  return res.status(405).json({ error: "Method not allowed" });
}
