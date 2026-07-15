// api/internal/inventory-aging/filters
//
// Filter option lists for the Inventory Aging panel. READ-ONLY.
// Returns { categories, brands, vendors, locations, genders } — the same
// dimensions the report RPC filters on (ip_category_master, brand_master,
// ip_vendor_master, inventory_locations, ip_item_master.gender_code).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 60 };

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveEntityId(admin, req) {
  const hdr = (req.headers?.["x-entity-id"] || "").toString().trim();
  if (UUID_RE.test(hdr)) return hdr;
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

const cmp = (a, b) => (a.name || "").localeCompare(b.name || "");

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const entityId = await resolveEntityId(admin, req);

    const [cats, brands, vendors, locs, genders] = await Promise.all([
      admin.from("ip_category_master").select("id, name").order("name"),
      admin.from("brand_master").select("id, name").order("name"),
      admin.from("ip_vendor_master").select("id, name").order("name"),
      admin.from("inventory_locations").select("id, name").order("name"),
      admin.from("ip_item_master").select("gender_code").not("gender_code", "is", null).limit(5000),
    ]);

    const err = cats.error || brands.error || vendors.error || locs.error || genders.error;
    if (err) throw new Error(err.message);

    const genderSet = Array.from(new Set((genders.data || []).map((r) => (r.gender_code || "").trim()).filter(Boolean))).sort();

    return res.status(200).json({
      entity_id: entityId,
      categories: (cats.data || []).filter((r) => r.name).sort(cmp),
      brands: (brands.data || []).filter((r) => r.name).sort(cmp),
      vendors: (vendors.data || []).filter((r) => r.name).sort(cmp),
      locations: (locs.data || []).filter((r) => r.name).sort(cmp),
      genders: genderSet,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
