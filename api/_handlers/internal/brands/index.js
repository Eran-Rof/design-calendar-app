// api/internal/brands
//
// P15 Brand Master — Chunk 2: list brands for the <BrandSwitcher>.
//
// GET /api/internal/brands[?entity_id=…]
//   → { entity_id, brands: [{ id, code, name, is_default, sort_order }] }
//
// Read-only, ungated (every internal user needs the list to render the global
// brand picker — same rationale as the entity switcher's list). Brands are
// append-only / migration-managed, so there's no write path here.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Brand-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveEntityId(admin, req) {
  const q = req.query?.entity_id;
  if (typeof q === "string" && UUID_RE.test(q)) return q;
  const h = req.headers?.["x-entity-id"];
  if (typeof h === "string" && UUID_RE.test(h.trim())) return h.trim();
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
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

  const entityId = await resolveEntityId(admin, req);
  if (!entityId) return res.status(404).json({ error: "Entity not found" });

  const { data, error } = await admin
    .from("brand_master")
    .select("id, code, name, is_default, sort_order")
    .eq("entity_id", entityId)
    .order("sort_order", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ entity_id: entityId, brands: data || [] });
}
