// api/internal/costing/add-vendor
//
// POST { name, entity_id? } → creates a minimal vendors row so the operator
// can pick a brand-new vendor straight from a costing quote without leaving
// the screen. Returns the inserted row.
//
// vendors.status defaults to 'active'. entity_id resolves from body →
// X-Entity-ID header → first entities row, same fallback the project create
// handler uses.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { name, entity_id, country, code } = body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });

  // Resolve entity_id (matches projects/index.js pattern).
  let resolvedEntityId = entity_id || req.headers["x-entity-id"] || null;
  if (!resolvedEntityId) {
    const { data: ent } = await admin.from("entities").select("id").limit(1).maybeSingle();
    resolvedEntityId = ent?.id || null;
  }

  const insert = {
    legal_name: String(name).trim(),
    status: "active",
  };
  if (resolvedEntityId) insert.entity_id = resolvedEntityId;
  if (code) insert.code = String(code).trim();
  if (country) insert.country = String(country).trim();

  const { data, error } = await admin.from("vendors").insert(insert).select("*").single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json(data);
}
