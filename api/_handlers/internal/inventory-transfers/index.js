// api/internal/inventory-transfers
//
// READ-ONLY list endpoint for M37 inventory transfers.
//
// GET — list transfers ordered by transfer_date DESC.
//       Query: ?item_id=<uuid>, ?from_location=<str>, ?to_location=<str>,
//              ?limit=<n> (default 100, max 500)
//
// POST — create ONE transfer row (location-to-location move). The Matrix
//        transfer UX in InternalInventoryTransfers.tsx calls this once per
//        non-zero cell, resolving each cell to a SKU id first. Body:
//          { item_id, qty, from_location, to_location,
//            transfer_date?, notes?, created_by_user_id? }
//
// PATCH/DELETE not exposed (transfers are append-only at this stage).
//
// Tangerine P3 Chunk 7.

import { createClient } from "@supabase/supabase-js";
import { resolveUserLabels } from "../../../_lib/resolveUserNames.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

// Validate + normalize a create body. Pure for testability. Returns
// { error } or { value: { item_id, qty, from_location, to_location,
//   transfer_date|null, notes|null, created_by_user_id|null } }.
export function parseCreateBody(body) {
  const b = body && typeof body === "object" ? body : {};

  const itemId = typeof b.item_id === "string" ? b.item_id.trim() : "";
  if (!itemId) return { error: "item_id is required" };
  if (!isUuid(itemId)) return { error: "item_id must be a uuid" };

  const qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty <= 0) return { error: "qty must be a positive number" };

  const fromLoc = typeof b.from_location === "string" ? b.from_location.trim() : "";
  if (!fromLoc) return { error: "from_location is required" };

  const toLoc = typeof b.to_location === "string" ? b.to_location.trim() : "";
  if (!toLoc) return { error: "to_location is required" };

  if (fromLoc === toLoc) return { error: "to_location must differ from from_location" };

  const out = {
    item_id: itemId,
    qty,
    from_location: fromLoc,
    to_location: toLoc,
    transfer_date: null,
    notes: null,
    created_by_user_id: null,
  };

  if (b.transfer_date != null && String(b.transfer_date).trim() !== "") {
    out.transfer_date = String(b.transfer_date).trim();
  }
  if (typeof b.notes === "string" && b.notes.trim() !== "") {
    out.notes = b.notes.trim();
  }
  const actor = typeof b.created_by_user_id === "string" ? b.created_by_user_id.trim() : "";
  if (actor && isUuid(actor)) out.created_by_user_id = actor;

  return { value: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      error: "Method not allowed. Inventory transfers supports GET (list) and POST (create).",
    });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "POST") {
    const parsedBody = parseCreateBody(req.body);
    if (parsedBody.error) return res.status(400).json({ error: parsedBody.error });
    const v = parsedBody.value;

    // from_location / to_location are warehouse CODES (e.g. MAIN_WH, WH-00001).
    // Resolve them to inventory_locations ids so the FIFO move RPC can shift the
    // actual on-hand layers between the two warehouses.
    const { data: locs, error: locErr } = await admin
      .from("inventory_locations")
      .select("id, code")
      .eq("entity_id", entityId)
      .in("code", [v.from_location, v.to_location]);
    if (locErr) return res.status(500).json({ error: locErr.message });
    const fromLoc = (locs || []).find((l) => l.code === v.from_location);
    const toLoc = (locs || []).find((l) => l.code === v.to_location);
    if (!fromLoc) return res.status(400).json({ error: `Unknown from warehouse "${v.from_location}"` });
    if (!toLoc) return res.status(400).json({ error: `Unknown to warehouse "${v.to_location}"` });

    // Move the stock FIFO (cost-preserving, conservation-checked in the RPC).
    // This is the source of truth — only if it succeeds do we log the transfer.
    const { error: moveErr } = await admin.rpc("transfer_inventory_between_locations", {
      p_item_id: v.item_id,
      p_qty: v.qty,
      p_from_location_id: fromLoc.id,
      p_to_location_id: toLoc.id,
      p_user_id: v.created_by_user_id || null,
      p_notes: v.notes || null,
    });
    if (moveErr) {
      // Insufficient on-hand / bad input surfaces as a Postgres exception.
      return res.status(400).json({ error: moveErr.message });
    }

    const insertRow = {
      entity_id: entityId,
      item_id: v.item_id,
      qty: v.qty,
      from_location: v.from_location,
      to_location: v.to_location,
    };
    if (v.transfer_date) insertRow.transfer_date = v.transfer_date;
    if (v.notes) insertRow.notes = v.notes;
    if (v.created_by_user_id) insertRow.created_by_user_id = v.created_by_user_id;

    const { data, error } = await admin
      .from("inventory_transfers")
      .insert(insertRow)
      .select("*")
      .single();
    // The stock already moved; a failed audit-row insert shouldn't 500 the move.
    if (error) return res.status(201).json({ moved: v.qty, warning: `Stock moved but audit-log insert failed: ${error.message}` });
    return res.status(201).json({ ...data, moved: v.qty });
  }

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

  // Enrich with a "created by" display label (items 3/4 — show + filter by user).
  const rows = data || [];
  const labels = await resolveUserLabels(admin, rows.map((r) => r.created_by_user_id));
  for (const r of rows) r.created_by_name = r.created_by_user_id ? (labels[r.created_by_user_id] || null) : null;
  return res.status(200).json(rows);
}
