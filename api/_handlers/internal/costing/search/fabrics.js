// api/internal/costing/search/fabrics
// GET ?q=<text>&entity_id=<uuid>  → up to 25 active fabric_codes
// ILIKE on code, name.

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
  const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];

  let query = admin.from("fabric_codes")
    .select("id, entity_id, code, name, composition_text, fabric_weight_gsm, country_of_origin_iso2, hts_code, default_vendor_id, is_active")
    .eq("is_active", true)
    .limit(25);
  if (entityId) query = query.eq("entity_id", entityId);
  if (q) {
    const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
    query = query.or(`code.ilike.${like},name.ilike.${like}`);
  }
  query = query.order("code", { ascending: true });

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ rows: data || [] });
}
