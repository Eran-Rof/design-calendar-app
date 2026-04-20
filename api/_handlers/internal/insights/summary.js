// api/internal/insights/summary
//
// GET — counts of live (non-expired, status=new) insights for an entity,
// for dashboard badges.
//   ?entity_id=<uuid>  required (or X-Entity-ID header)
//   Response: { new_count, by_type: { cost_saving, risk_alert, ... } }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

const TYPES = [
  "cost_saving", "risk_alert", "consolidation",
  "contract_renewal", "performance_trend", "market_benchmark",
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
  if (!entityId) return res.status(400).json({ error: "entity_id query or X-Entity-ID header required" });

  const nowIso = new Date().toISOString();
  const { data, error } = await admin.from("ai_insights")
    .select("type")
    .eq("entity_id", entityId).eq("status", "new").gt("expires_at", nowIso);
  if (error) return res.status(500).json({ error: error.message });

  const by_type = Object.fromEntries(TYPES.map((t) => [t, 0]));
  for (const row of data || []) {
    if (by_type[row.type] !== undefined) by_type[row.type] += 1;
  }
  const new_count = Object.values(by_type).reduce((a, b) => a + b, 0);
  return res.status(200).json({ new_count, by_type });
}
