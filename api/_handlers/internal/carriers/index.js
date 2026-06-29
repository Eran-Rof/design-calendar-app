// api/internal/carriers
//
// GET  — list carrier_master rows for the default entity. By default returns
//        is_active=true rows only; ?include_inactive=true returns all.
//        Query:
//          ?q=<search>             — ilike match on code or name
//          ?carrier_type=<type>    — filter by carrier_type
//          ?include_inactive=true  — include inactive rows
// POST — create one carrier_master row. Body:
//          { name (required),
//            carrier_type (default 'parcel'),
//            tracking_url_template (optional),
//            sort_order (>=0, optional, default 0),
//            is_active (default true) }
//          NOTE: code is AUTO-GENERATED (CARR-NNNNN) by a DB trigger and is
//          immutable. Existing meaningful codes (ABF/AMAZON/DHL …) are
//          preserved; new carriers get a CARR-NNNNN code on save.
//
// Tangerine — Carrier Master.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const VALID_TYPES = new Set(["parcel", "ltl", "ocean", "air", "other"]);

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
    const carrierType = (url.searchParams.get("carrier_type") || "").trim();

    let query = admin
      .from("carrier_master")
      .select("*")
      .eq("entity_id", entityId)
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`code.ilike.%${esc}%,name.ilike.%${esc}%`);
    }
    if (carrierType) query = query.eq("carrier_type", carrierType);

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

    const { data, error } = await admin
      .from("carrier_master")
      .insert({ ...v.data, entity_id: entityId })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Could not allocate a unique carrier code; please retry" });
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
  // `code` is AUTO-GENERATED (CARR-NNNNN) by a DB trigger + immutable — any
  // client-supplied code is ignored on create and frozen on update. Existing
  // meaningful codes (ABF/AMAZON/DHL …) are preserved.
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }

  const carrierType = body.carrier_type ? String(body.carrier_type).trim() : "parcel";
  if (!VALID_TYPES.has(carrierType)) {
    return { error: `carrier_type must be one of: ${[...VALID_TYPES].join(", ")}` };
  }

  let sortOrder = 0;
  if (body.sort_order != null && body.sort_order !== "") {
    sortOrder = typeof body.sort_order === "number" ? body.sort_order : parseInt(body.sort_order, 10);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return { error: "sort_order must be a non-negative integer" };
    }
  }

  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;

  const trackingUrl = body.tracking_url_template ? String(body.tracking_url_template).trim() || null : null;

  return {
    data: {
      name:                  String(body.name).trim(),
      carrier_type:          carrierType,
      tracking_url_template: trackingUrl,
      sort_order:            sortOrder,
      is_active:             isActive,
    },
  };
}
