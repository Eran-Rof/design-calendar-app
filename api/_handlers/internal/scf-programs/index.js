// api/internal/scf-programs
//
// GET  — list programs for an entity (with aggregate utilization).
// POST — create program.
//   body: { entity_id, name, funder_name, max_facility_amount, base_rate_pct, status? }

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
    let q = admin.from("supply_chain_finance_programs").select("*").order("created_at", { ascending: false });
    if (entityId) q = q.eq("entity_id", entityId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ rows: data || [] });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { entity_id, name, funder_name, max_facility_amount, base_rate_pct, status } = body || {};
    if (!entity_id || !name || !funder_name) return res.status(400).json({ error: "entity_id, name, and funder_name required" });
    const max = Number(max_facility_amount); const rate = Number(base_rate_pct);
    if (!Number.isFinite(max) || max <= 0) return res.status(400).json({ error: "max_facility_amount must be > 0" });
    if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: "base_rate_pct must be >= 0" });

    const { data, error } = await admin.from("supply_chain_finance_programs").insert({
      entity_id, name: String(name).trim(), funder_name: String(funder_name).trim(),
      max_facility_amount: max, base_rate_pct: rate,
      status: status || "active",
    }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
