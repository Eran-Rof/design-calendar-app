// api/internal/fabric-mills
//
// GET  — list fabric mills for the default entity. By default returns
//        is_active=true rows only; ?include_inactive=true returns all.
//        Query:
//          ?q=<search>             — ilike match on code, name, or country_code
//          ?include_inactive=true  — include inactive rows
// POST — create one fabric_mill_master row. Body:
//          { name (required),
//            country_code, contact_name, contact_email, website, notes
//            sort_order (>=0, optional, default 0), is_active (default true) }
//          The `code` is SERVER-GENERATED (MILL-NNNNN); any client-supplied
//          `code` is ignored. (Auto-coded master — operator item 14 pattern.)
//
// Tangerine — Fabric Mill Master. Mirrors the rma-reasons handler shape
// (resolveDefaultEntityId + ROF scope; service-role writes; anon-read in DB).

import { createClient } from "@supabase/supabase-js";
import { insertWithAutoCode } from "../../../_lib/autoCode.js";

export const config = { maxDuration: 15 };

// Fabric mill codes are server-generated + read-only (operator item 14): PREFIX +
// 5-digit zero-padded sequence (count existing rows carrying the prefix, +1),
// e.g. MILL-00001.
const CODE_PREFIX = "MILL-";

// Up to `max` contacts, each {name,email,phone,title} (strings only). Blank
// rows are dropped; everything beyond `max` is truncated. Mirrors the
// customers.contacts sanitizer.
export function sanitizeContacts(raw, max) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: "contacts must be an array" };
  const keys = ["name", "email", "phone", "title"];
  const out = [];
  for (const c of raw) {
    if (c == null || typeof c !== "object") continue;
    const row = {};
    for (const k of keys) {
      const val = c[k];
      if (val != null && String(val).trim() !== "") row[k] = String(val).trim();
    }
    if (Object.keys(row).length) out.push(row);
    if (out.length >= max) break;
  }
  return out;
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

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const includeInactive = url.searchParams.get("include_inactive") === "true";
    const q = (url.searchParams.get("q") || "").trim();

    let query = admin
      .from("fabric_mill_master")
      .select("*")
      .eq("entity_id", entityId)
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`code.ilike.%${esc}%,name.ilike.%${esc}%,country_code.ilike.%${esc}%`);
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

    // `code` is always server-generated; any client-supplied code is ignored.
    const buildRow = (code) => ({ ...v.data, code, entity_id: entityId });

    const { data, error } = await insertWithAutoCode(
      admin, "fabric_mill_master", "code", CODE_PREFIX, buildRow, { entityId },
    );
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Could not allocate a unique fabric mill code; please retry" });
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
  // `code` is server-generated (MILL-NNNNN); not required from the client.
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

  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;

  const data = {
    // code is injected by the handler (server-generated); not taken from body.
    name:       String(body.name).trim(),
    sort_order: sortOrder,
    is_active:  isActive,
  };

  if (body.country_code != null) data.country_code = String(body.country_code).trim() || null;
  if (body.contact_name  != null) data.contact_name  = String(body.contact_name).trim()  || null;
  if (body.contact_email != null) data.contact_email = String(body.contact_email).trim() || null;
  if (body.website       != null) data.website       = String(body.website).trim()       || null;
  if (body.notes         != null) data.notes         = String(body.notes).trim()         || null;

  if (body.contacts != null) {
    const c = sanitizeContacts(body.contacts, 5);
    if (c && c.error) return { error: c.error };
    data.contacts = c;
  }

  return { data };
}
