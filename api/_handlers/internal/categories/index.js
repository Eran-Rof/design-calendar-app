// api/internal/categories
//
// GET — read-only list of ip_category_master rows for the default entity, used
// by the PO "Department" dropdown. By default returns only the MAIN categories
// (top level: parent_category_id IS NULL) and active rows.
//   ?all=true            include sub-categories (all levels)
//   ?include_inactive=true  include inactive rows
//   ?q=<search>          ilike match on name / category_code
//
// Reuses the ip_category_master table seeded from item group_name (#1243).

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
async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const all = url.searchParams.get("all") === "true";
  const includeInactive = url.searchParams.get("include_inactive") === "true";
  const q = (url.searchParams.get("q") || "").trim();

  let query = admin
    .from("ip_category_master")
    .select("id, category_code, name, segment, parent_category_id, level, active")
    .eq("entity_id", entityId)
    .order("name", { ascending: true });

  if (!all) query = query.is("parent_category_id", null); // main categories only
  if (!includeInactive) query = query.eq("active", true);
  if (q) {
    const safe = q.replace(/[,%()]/g, " ").trim();
    if (safe) query = query.or(`name.ilike.%${safe}%,category_code.ilike.%${safe}%`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
