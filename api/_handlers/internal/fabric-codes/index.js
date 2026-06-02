// api/internal/fabric-codes
//
// GET  — list fabric_codes for the default entity (ROF).
//        Query: ?include_inactive=true   show is_active=false rows (default: only active)
//               ?q=<search>              ILIKE over code/name/composition_text
//               ?country=US              filter by country_of_origin_iso2 (uppercased)
//               ?limit=N                 default 200, max 500
// POST — create a new fabric code. Body: {
//          code, name, composition_text,
//          composition_json?, fabric_weight_gsm?, country_of_origin_iso2?,
//          hts_code?, care_instructions?, default_vendor_id?, is_active?
//        }
//
// Tangerine P3 Chunk 11.

import { createClient } from "@supabase/supabase-js";
import { insertWithAutoCode } from "../../../_lib/autoCode.js";

export const config = { maxDuration: 15 };

// Chunk M — fabric codes are server-generated + read-only (operator item 14).
const CODE_PREFIX = "FAB-";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const country = (url.searchParams.get("country") || "").trim().toUpperCase();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);

    let query = admin
      .from("fabric_codes")
      .select("id, code, name, composition_text, composition_json, fabric_weight_gsm, country_of_origin_iso2, hts_code, care_instructions, default_vendor_id, is_active, created_at, updated_at")
      .eq("entity_id", entityId)
      .order("code", { ascending: true })
      .limit(limit);

    if (!includeInactive) query = query.eq("is_active", true);
    if (q) query = query.or(`code.ilike.%${q}%,name.ilike.%${q}%,composition_text.ilike.%${q}%`);
    if (country) {
      if (!/^[A-Z]{2}$/.test(country)) {
        return res.status(400).json({ error: "country filter must be ISO-2 (2 letters)" });
      }
      query = query.eq("country_of_origin_iso2", country);
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

    // Chunk M — `code` is always server-generated; any client-supplied code is ignored.
    const buildRow = (code) => ({
      entity_id: entityId,
      code,
      name: v.data.name,
      composition_text: v.data.composition_text,
      composition_json: v.data.composition_json ?? null,
      fabric_weight_gsm: v.data.fabric_weight_gsm ?? null,
      country_of_origin_iso2: v.data.country_of_origin_iso2 ?? null,
      hts_code: v.data.hts_code ?? null,
      care_instructions: v.data.care_instructions ?? null,
      default_vendor_id: v.data.default_vendor_id ?? null,
      is_active: v.data.is_active !== false,
    });

    const { data, error } = await insertWithAutoCode(
      admin, "fabric_codes", "code", CODE_PREFIX, buildRow, { entityId },
    );

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Could not allocate a unique fabric code; please retry" });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  // Chunk M — `code` is server-generated; no longer required from the client.
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }
  if (!body.composition_text || !String(body.composition_text).trim()) {
    return { error: "composition_text is required" };
  }

  const out = {
    // code is injected by the handler (server-generated); not taken from body.
    name: String(body.name).trim(),
    composition_text: String(body.composition_text).trim(),
  };

  if (body.composition_json != null && body.composition_json !== "") {
    if (typeof body.composition_json === "string") {
      try { out.composition_json = JSON.parse(body.composition_json); }
      catch { return { error: "composition_json must be valid JSON" }; }
    } else {
      out.composition_json = body.composition_json;
    }
  }

  if (body.fabric_weight_gsm != null && body.fabric_weight_gsm !== "") {
    const w = Number(body.fabric_weight_gsm);
    if (!Number.isFinite(w) || w < 0) {
      return { error: "fabric_weight_gsm must be a non-negative number" };
    }
    out.fabric_weight_gsm = w;
  }

  if (body.country_of_origin_iso2 != null && body.country_of_origin_iso2 !== "") {
    const c = String(body.country_of_origin_iso2).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) {
      return { error: "country_of_origin_iso2 must be 2 letters (ISO 3166-1 alpha-2)" };
    }
    out.country_of_origin_iso2 = c;
  }

  if (body.hts_code != null && body.hts_code !== "") {
    out.hts_code = String(body.hts_code).trim();
  }

  if (body.care_instructions != null && body.care_instructions !== "") {
    out.care_instructions = String(body.care_instructions).trim();
  }

  if (body.default_vendor_id != null && body.default_vendor_id !== "") {
    if (!UUID_RE.test(String(body.default_vendor_id))) {
      return { error: "default_vendor_id must be a uuid" };
    }
    out.default_vendor_id = String(body.default_vendor_id);
  }

  if (typeof body.is_active === "boolean") {
    out.is_active = body.is_active;
  } else {
    out.is_active = true;
  }

  return { data: out };
}
