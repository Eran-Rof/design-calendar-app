// api/internal/ar-collections/summary
//
// GET — AR Collections KPI summary via the ar_collections_kpi() RPC:
//   ours open/overdue $, per-bucket breakdown, factored $ (Rosenthal's to
//   collect), promised $, broken-promise $, and recent DSO trend.
// Read-only, aggregated server-side (no 16k-row fetch).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

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

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  try {
    const { data, error } = await admin.rpc("ar_collections_kpi", { p_entity_id: entityId });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ kpi: data });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
