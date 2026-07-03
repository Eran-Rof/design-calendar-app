// api/internal/colors
//
// GET  — list colors for the default entity. By default returns is_active=true
//        rows only; ?include_inactive=true returns all.
//        Query:
//          ?q=<search>             — ilike match on name or code
//          ?include_inactive=true  — include inactive rows
// POST — create one color_master row (admin "+ Add new color" in Style Master).
//        Body: { name (required), code?, hex?, sort_order? }
//        Idempotent: a name that already exists (case-insensitive) returns the
//        existing row with 200 so the caller can use its id either way.
//
// Tangerine — Color Master. Mirrors the seasons handler shape
// (resolveDefaultEntityId + ROF scope; service-role writes; anon-read in DB),
// minus the server-generated code — a color is just a named row.

import { createClient } from "@supabase/supabase-js";

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

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const includeInactive = url.searchParams.get("include_inactive") === "true";
    const q = (url.searchParams.get("q") || "").trim();

    let query = admin
      .from("color_master")
      .select("id, name, code, hex, hex_b, sort_order, is_active, nrf_code, nrf_name")
      .eq("entity_id", entityId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`name.ilike.%${esc}%,code.ilike.%${esc}%`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const row = { ...v.data, entity_id: entityId };
    const { data, error } = await admin
      .from("color_master")
      .insert(row)
      .select("id, name, code, hex, hex_b, sort_order, is_active, nrf_code, nrf_name")
      .single();

    if (error) {
      // Already exists (case-insensitive name) → return the existing row so the
      // caller can use its id. Mirrors the "409 is success" addSeason UX.
      if (error.code === "23505") {
        const { data: existing } = await admin
          .from("color_master")
          .select("id, name, code, hex, hex_b, sort_order, is_active, nrf_code, nrf_name")
          .eq("entity_id", entityId)
          .ilike("name", v.data.name)
          .maybeSingle();
        if (existing) return res.status(200).json(existing);
        return res.status(409).json({ error: "A color with this name already exists" });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }
  let sortOrder = 0;
  if (body.sort_order != null && body.sort_order !== "") {
    sortOrder = typeof body.sort_order === "number" ? body.sort_order : parseInt(body.sort_order, 10);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return { error: "sort_order must be a non-negative integer" };
    }
  }
  // Optional #RRGGBB swatches (hex = Color A, hex_b = optional Color B for a
  // two-tone swatch) — accept with or without leading '#', else null.
  let hex = null;
  if (body.hex != null && String(body.hex).trim() !== "") {
    const h = String(body.hex).trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return { error: "hex must be a 6-digit #RRGGBB value" };
    hex = `#${h.toLowerCase()}`;
  }
  let hexB = null;
  if (body.hex_b != null && String(body.hex_b).trim() !== "") {
    const h = String(body.hex_b).trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return { error: "hex_b must be a 6-digit #RRGGBB value" };
    hexB = `#${h.toLowerCase()}`;
  }
  return {
    data: {
      name:       String(body.name).trim(),
      code:       body.code != null && String(body.code).trim() !== "" ? String(body.code).trim() : null,
      hex,
      hex_b:      hexB,
      sort_order: sortOrder,
      is_active:  true,
      nrf_code:   body.nrf_code != null && String(body.nrf_code).trim() !== "" ? String(body.nrf_code).trim() : null,
      nrf_name:   body.nrf_name != null && String(body.nrf_name).trim() !== "" ? String(body.nrf_name).trim() : null,
    },
  };
}
