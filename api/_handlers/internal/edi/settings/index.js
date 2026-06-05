// api/internal/edi/settings
//
// Per-entity EDI VAN / interchange configuration (a singleton-ish row per
// entity).
//
// GET       — fetch the current entity's edi_settings row (or null when none).
// PUT/POST  — upsert the single row for the default entity. Body (all optional):
//               { van_provider, van_host, van_username, van_password_enc,
//                 isa_sender_qualifier, isa_sender_id, gs_sender_id,
//                 test_mode (bool), is_active (bool) }
//
// Tangerine — EDI Settings. Service-role writes; anon-read in DB (RLS). The
// van_password_enc field is a PLACEHOLDER (stored as-is, no crypto yet).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const STRING_FIELDS = [
  "van_provider", "van_host", "van_username", "van_password_enc",
  "isa_sender_qualifier", "isa_sender_id", "gs_sender_id",
];
const BOOL_FIELDS = ["test_mode", "is_active"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
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

function toBool(v) {
  return typeof v === "boolean" ? v : v === "true" || v === 1 || v === "1";
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("edi_settings")
      .select("*")
      .eq("entity_id", entityId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || null);
  }

  if (req.method === "PUT" || req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    if (body == null || typeof body !== "object") {
      return res.status(400).json({ error: "Request body must be an object" });
    }

    const row = { entity_id: entityId };
    for (const f of STRING_FIELDS) {
      if (f in body) row[f] = body[f] == null ? null : String(body[f]).trim() || null;
    }
    for (const f of BOOL_FIELDS) {
      if (f in body) row[f] = toBool(body[f]);
    }

    const { data, error } = await admin
      .from("edi_settings")
      .upsert(row, { onConflict: "entity_id" })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  res.setHeader("Allow", "GET, PUT, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
