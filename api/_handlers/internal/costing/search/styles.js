// api/internal/costing/search/styles
// GET ?q=<text>&entity_id=<uuid>  → up to 50 style_master rows
// ILIKE on style_code, description, style_name.
//
// entity_id filter is OPT-IN (only applied when explicitly passed). The
// picker doesn't send it because most costing operators source styles
// from across entities (planning/design vs. AR), same as the vendor and
// color pickers. Service-role bypasses RLS so the cross-entity read is
// safe at the API layer.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const q = (url.searchParams.get("q") || "").trim();
  // Only filter by entity when the caller explicitly passes ?entity_id=
  // — the picker doesn't send one because pickers operate cross-entity
  // (Xoro nightly sync populates style_master per-entity; sparse entities
  // would otherwise see an empty dropdown).
  const entityId = url.searchParams.get("entity_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1000);

  let query = admin.from("style_master")
    .select("id, entity_id, style_code, style_name, description, gender_code, category_id, season, base_fabric, lifecycle_status")
    .is("deleted_at", null)
    .limit(limit);
  if (entityId) query = query.eq("entity_id", entityId);
  if (q) {
    const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
    query = query.or(`style_code.ilike.${like},description.ilike.${like},style_name.ilike.${like}`);
  }
  query = query.order("style_code", { ascending: true });

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ rows: data || [] });
}
