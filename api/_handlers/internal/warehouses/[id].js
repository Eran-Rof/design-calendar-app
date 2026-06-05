// api/internal/warehouses/[id]
//
// GET    — fetch a single warehouse (inventory_locations) row.
// PATCH  — update mutable fields. `code`, `kind`, `entity_id` are LOCKED
//          post-creation. Mutable: name, address, country_code, sort_order,
//          is_active.
// DELETE — hard-delete. Rejected (409) if any inventory_layers row still
//          references this location by FK (location_id), or any
//          inventory_transfers row references its code as from/to_location
//          (free text). Toggle is_active=false instead in that case.
//
// Tangerine — Warehouse Master (over inventory_locations).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTABLE_FIELDS = new Set(["name", "address", "country_code", "sort_order", "is_active"]);
const LOCKED_FIELDS = new Set(["code", "kind", "entity_id", "id"]);

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Per feedback_dispatcher_query_not_params: always read path params from req.query.
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("inventory_locations")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Warehouse not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    if (Object.keys(v.data).length === 0) {
      return res.status(400).json({ error: "No mutable fields supplied" });
    }
    const { data, error } = await admin
      .from("inventory_locations")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Warehouse not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Fetch the warehouse first; we need its code to check free-text references
    // from inventory_transfers (from_location/to_location are text on the code).
    const { data: row, error: getErr } = await admin
      .from("inventory_locations")
      .select("code")
      .eq("id", id)
      .maybeSingle();
    if (getErr) return res.status(500).json({ error: getErr.message });
    if (!row) return res.status(404).json({ error: "Warehouse not found" });

    // FK reference: inventory_layers.location_id.
    const { count: layerCount, error: layerErr } = await admin
      .from("inventory_layers")
      .select("id", { count: "exact", head: true })
      .eq("location_id", id);
    if (layerErr) return res.status(500).json({ error: layerErr.message });

    // Free-text reference: inventory_transfers.from_location / to_location.
    const { count: transferCount, error: transErr } = await admin
      .from("inventory_transfers")
      .select("id", { count: "exact", head: true })
      .or(`from_location.eq.${row.code},to_location.eq.${row.code}`);
    if (transErr) return res.status(500).json({ error: transErr.message });

    const layers = layerCount || 0;
    const transfers = transferCount || 0;
    if (layers > 0 || transfers > 0) {
      return res.status(409).json({
        error: "Warehouse is still referenced by inventory layers or transfers. Move that stock first, or toggle is_active=false instead.",
        references: { inventory_layers: layers, inventory_transfers: transfers },
      });
    }

    const { data, error } = await admin
      .from("inventory_locations")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Warehouse not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  for (const f of Object.keys(body)) {
    if (LOCKED_FIELDS.has(f)) {
      return { error: `${f} is locked post-creation and cannot be updated` };
    }
  }

  const out = {};
  for (const [k, val] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(k)) continue;
    out[k] = val;
  }

  if ("name" in out) {
    if (out.name == null || String(out.name).trim() === "") {
      return { error: "name cannot be empty" };
    }
    out.name = String(out.name).trim();
  }

  if ("address" in out) {
    out.address = out.address != null && String(out.address).trim() ? String(out.address).trim() : null;
  }

  if ("country_code" in out) {
    out.country_code = out.country_code != null && String(out.country_code).trim() ? String(out.country_code).trim() : null;
  }

  if ("sort_order" in out) {
    if (out.sort_order == null || out.sort_order === "") {
      out.sort_order = 0;
    } else {
      const n = typeof out.sort_order === "number" ? out.sort_order : parseInt(out.sort_order, 10);
      if (!Number.isInteger(n) || n < 0) {
        return { error: "sort_order must be a non-negative integer" };
      }
      out.sort_order = n;
    }
  }

  if ("is_active" in out) {
    if (typeof out.is_active !== "boolean") {
      out.is_active = out.is_active === "true" || out.is_active === 1;
    }
  }

  return { data: out };
}
