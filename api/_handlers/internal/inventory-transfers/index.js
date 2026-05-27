// api/internal/inventory-transfers
//
// READ-ONLY list endpoint for M37 inventory transfers.
//
// GET — list transfers ordered by transfer_date DESC.
//       Query: ?item_id=<uuid>, ?from_location=<str>, ?to_location=<str>,
//              ?limit=<n> (default 100, max 500)
//
// POST/PATCH/DELETE not exposed in this skeleton chunk. Multi-warehouse +
// transfer creation UX lands when M37 ships its full chunk. Schema exists
// for forward compatibility.
//
// Tangerine P3 Chunk 7.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

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
    .from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (error || !data) return null;
  return data.id;
}

// Strict UUID format: 8-4-4-4-12 hex chars with dashes at exact positions.
export function isUuid(s) {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// Parse + validate query filters. Pure for testability.
export function parseListQuery(searchParams) {
  const out = { error: null, filters: {}, limit: 100 };

  const itemId = (searchParams.get("item_id") || "").trim();
  if (itemId) {
    if (!isUuid(itemId)) return { error: "item_id must be a uuid" };
    out.filters.item_id = itemId;
  }

  const fromLoc = (searchParams.get("from_location") || "").trim();
  if (fromLoc) out.filters.from_location = fromLoc;

  const toLoc = (searchParams.get("to_location") || "").trim();
  if (toLoc) out.filters.to_location = toLoc;

  const limitRaw = searchParams.get("limit");
  if (limitRaw != null && limitRaw !== "") {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n <= 0) return { error: "limit must be a positive integer" };
    out.limit = Math.min(n, 500);
  }

  return out;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Method not allowed. Inventory transfers list is read-only at this skeleton stage; creation UX lands when M37 multi-warehouse ships.",
    });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const parsed = parseListQuery(url.searchParams);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  let query = admin
    .from("inventory_transfers")
    .select("*")
    .eq("entity_id", entityId)
    .order("transfer_date", { ascending: false })
    .limit(parsed.limit);

  if (parsed.filters.item_id) query = query.eq("item_id", parsed.filters.item_id);
  if (parsed.filters.from_location) query = query.eq("from_location", parsed.filters.from_location);
  if (parsed.filters.to_location) query = query.eq("to_location", parsed.filters.to_location);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
