// api/internal/factors
//
// GET  — list factor_master for the default entity (ROF). Default
//        is_active=true only; ?include_inactive=true returns all.
//        ?q=<search> ilike on code/name/contact_name. Ordered name, code.
// POST — create one factor_master row. Body:
//          { code (required, uppercased), name (required), contact_name,
//            phone, email, website, address (jsonb obj), api_enabled (bool),
//            notes, is_active (default true) }
//
// Chunk I — Factor / Insurance Master. Entity-scoped (ROF). A "factor" is a
// receivables financier / insurer; full contact profile is captured here.

import { createClient } from "@supabase/supabase-js";
import { insertWithAutoCode } from "../../../_lib/autoCode.js";

export const config = { maxDuration: 15 };

// Chunk M — factor/insurance codes are server-generated + read-only (operator item 14).
const CODE_PREFIX = "FCT-";

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
      .from("factor_master")
      .select("*")
      .eq("entity_id", entityId)
      .order("name", { ascending: true })
      .order("code", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`code.ilike.%${esc}%,name.ilike.%${esc}%,contact_name.ilike.%${esc}%`);
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
    const { data, error } = await insertWithAutoCode(
      admin, "factor_master", "code", CODE_PREFIX,
      (code) => ({ ...v.data, code, entity_id: entityId }),
      { entityId },
    );
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Could not allocate a unique factor code; please retry" });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// Shared field coercion used by both index POST and [id] PATCH.
export function normalizeContactFields(body, out) {
  for (const f of ["contact_name", "phone", "email", "website", "notes"]) {
    if (f in body) {
      const val = body[f];
      out[f] = val == null || String(val).trim() === "" ? null : String(val).trim();
    }
  }
  if ("address" in body) {
    const a = body.address;
    if (a == null) {
      out.address = {};
    } else if (typeof a === "object" && !Array.isArray(a)) {
      out.address = a;
    } else {
      return { error: "address must be an object" };
    }
  }
  if ("api_enabled" in body) {
    const v = body.api_enabled;
    out.api_enabled = typeof v === "boolean" ? v : v === "true" || v === 1;
  }
  return { ok: true };
}

export function validateInsert(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  // Chunk M — `code` is server-generated; no longer required/validated from the client.
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }

  if (body.email != null && String(body.email).trim() !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email).trim())) {
    return { error: "email is not a valid address" };
  }

  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;

  const out = {
    // code is injected by the handler (server-generated); not taken from body.
    name:        String(body.name).trim(),
    api_enabled: false,
    address:     {},
    is_active:   isActive,
  };
  const r = normalizeContactFields(body, out);
  if (r && r.error) return { error: r.error };

  return { data: out };
}
