// api/internal/customer-locations
//
// GET  ?customer_id=<uuid>
//        List a customer's locations.  active=true rows first, then by name.
//        Pass ?include_inactive=true to include soft-deleted (active=false) rows.
//
// POST  Create a location.
//        Body: { customer_id (required), name (required), code?, address?,
//                contact_name?, phone?, email?, is_default? }
//        If is_default=true, any existing default for the same customer is
//        cleared first (via an UPDATE ... WHERE is_default so the partial-unique
//        index never sees two live defaults at once).
//        Returns 201 with the created row.
//
// Ship-to locations — Tangerine customer multi-DC / multi-store (PR #shipto).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_TYPES = ["dc", "store", "other"];

function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

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
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const customerId    = (url.searchParams.get("customer_id") || "").trim();
    const includeInactive = url.searchParams.get("include_inactive") === "true";

    if (!customerId) {
      return res.status(400).json({ error: "customer_id query param is required" });
    }
    if (!isUuid(customerId)) {
      return res.status(400).json({ error: "customer_id must be a uuid" });
    }

    let query = admin
      .from("customer_locations")
      .select("*")
      .eq("entity_id", entityId)
      .eq("customer_id", customerId)
      .order("active",      { ascending: false })  // active rows first
      .order("is_default",  { ascending: false })  // default within active first
      .order("name",        { ascending: true });

    if (!includeInactive) {
      query = query.eq("active", true);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    // --- validate ---
    if (!body.customer_id || !isUuid(body.customer_id)) {
      return res.status(400).json({ error: "customer_id (uuid) is required" });
    }
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    let locationType = "store";
    if (body.location_type != null && body.location_type !== "") {
      locationType = String(body.location_type).trim().toLowerCase();
      if (!LOCATION_TYPES.includes(locationType)) {
        return res.status(400).json({ error: `location_type must be one of ${LOCATION_TYPES.join(", ")}` });
      }
    }

    const row = {
      entity_id:    entityId,
      customer_id:  body.customer_id,
      name:         String(body.name).trim(),
      code:         body.code   ? String(body.code).trim()         || null : null,
      location_type: locationType,
      address:      body.address && typeof body.address === "object"
                      ? body.address : {},
      contact_name: body.contact_name ? String(body.contact_name).trim() || null : null,
      phone:        body.phone        ? String(body.phone).trim()        || null : null,
      email:        body.email        ? String(body.email).trim()        || null : null,
      is_default:   body.is_default === true,
      active:       true,
    };

    // If the new location is the default, clear any existing default first
    // so the partial-unique index (WHERE is_default) is never violated.
    if (row.is_default) {
      const { error: clearErr } = await admin
        .from("customer_locations")
        .update({ is_default: false })
        .eq("customer_id", body.customer_id)
        .eq("is_default", true);
      if (clearErr) return res.status(500).json({ error: `Failed to clear previous default: ${clearErr.message}` });
    }

    const { data, error } = await admin
      .from("customer_locations")
      .insert(row)
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
