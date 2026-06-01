// api/internal/inventory-on-hand
//
// Tangerine P15 — Inventory On-Hand by Brand Pool read report.
//
// Reads v_inventory_on_hand_by_partition (aggregated FIFO layers with
// remaining_qty > 0, grouped by entity / partition / item).
//
// GET — returns rows for the resolved entity (ROF default or X-Entity-ID header).
//
//   Optional query params:
//     ?partition_id=<uuid>   filter to a specific brand pool
//     ?brand_id=<uuid>       filter to a specific brand (via partition.brand_id)
//     ?q=<string>            ilike search on sku_code OR description (≥2 chars)
//
//   Rows ordered by partition_code ASC, sku_code ASC.
//
//   Returns: { entity_id, rows: [ { entity_id, partition_id, partition_code,
//               partition_name, brand_id, brand_code, brand_name, item_id,
//               sku_code, description, on_hand_qty, on_hand_value_cents } ] }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

// P10-8 D9: respect X-Entity-ID header; fall back to ROF.
async function resolveReportEntityId(admin, req) {
  const hdr = (req.headers?.["x-entity-id"] || req.headers?.["X-Entity-ID"] || "").toString().trim();
  if (hdr) {
    const { data } = await admin.from("entities").select("id").eq("id", hdr).maybeSingle();
    if (data?.id) return data.id;
  }
  return await resolveDefaultEntityId(admin);
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

  const entityId = await resolveReportEntityId(admin, req);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const partitionId = (url.searchParams.get("partition_id") || "").trim();
  const brandId     = (url.searchParams.get("brand_id")     || "").trim();
  const q           = (url.searchParams.get("q")            || "").trim();

  // Validate UUIDs
  if (partitionId && !UUID_RE.test(partitionId)) {
    return res.status(400).json({ error: "partition_id must be a uuid" });
  }
  if (brandId && !UUID_RE.test(brandId)) {
    return res.status(400).json({ error: "brand_id must be a uuid" });
  }

  try {
    let query = admin
      .from("v_inventory_on_hand_by_partition")
      .select(
        "entity_id, partition_id, partition_code, partition_name, brand_id, brand_code, brand_name, item_id, sku_code, description, on_hand_qty, on_hand_value_cents"
      )
      .eq("entity_id", entityId);

    if (partitionId) {
      query = query.eq("partition_id", partitionId);
    }
    if (brandId) {
      query = query.eq("brand_id", brandId);
    }
    if (q && q.length >= 2) {
      query = query.or(`sku_code.ilike.%${q}%,description.ilike.%${q}%`);
    }

    query = query.order("partition_code", { ascending: true }).order("sku_code", { ascending: true });

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ entity_id: entityId, rows: data || [] });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
