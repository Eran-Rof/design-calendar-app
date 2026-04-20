// api/internal/scf-programs/:id
//
// PUT — update status / limits / rate.
//   body: { status?, max_facility_amount?, base_rate_pct? }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("scf-programs");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing program id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const updates = {};
  if (body?.status !== undefined) {
    if (!["active", "paused", "terminated"].includes(body.status)) return res.status(400).json({ error: "invalid status" });
    updates.status = body.status;
  }
  if (body?.max_facility_amount !== undefined) {
    const n = Number(body.max_facility_amount);
    if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: "max_facility_amount must be > 0" });
    updates.max_facility_amount = n;
  }
  if (body?.base_rate_pct !== undefined) {
    const n = Number(body.base_rate_pct);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "base_rate_pct must be >= 0" });
    updates.base_rate_pct = n;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields" });
  updates.updated_at = new Date().toISOString();

  const { error } = await admin.from("supply_chain_finance_programs").update(updates).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, id, ...updates });
}
