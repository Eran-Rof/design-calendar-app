// api/internal/size-scales
//
// GET  — list size scales for the default entity. By default returns
//        is_active=true rows only; ?include_inactive=true returns all.
//        Query:
//          ?q=<search>             — ilike match on code or name
//          ?include_inactive=true  — include inactive rows
// POST — create one size_scales row. Body:
//          { name (required),
//            sizes (array of strings OR comma-separated string, ORDERED),
//            sort_order (>=0, optional, default 0), is_active (default true) }
//          The `code` is SERVER-GENERATED (SCALE-NNNNN); any client-supplied
//          `code` is ignored. (Auto-coded master — operator item 14 pattern.)
//
// Tangerine — Size Scale Master. Mirrors the payment-terms handler shape
// (resolveDefaultEntityId + ROF scope; service-role writes; anon-read in DB).
// The `sizes` column is a Postgres text[] — order is preserved exactly as sent.

import { createClient } from "@supabase/supabase-js";
import { insertWithAutoCode } from "../../../_lib/autoCode.js";

export const config = { maxDuration: 15 };

// Chunk M — size-scale codes are server-generated + read-only (operator item 14).
// Same scheme as the other auto-coded masters: PREFIX + 5-digit zero-padded
// sequence (count existing rows carrying the prefix, +1), e.g. SCALE-00001.
const CODE_PREFIX = "SCALE-";

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

// Normalize a `sizes` value to an ordered array of non-empty trimmed strings.
// Accepts a JSON array of strings, or a comma-separated string. ORDER PRESERVED.
export function normalizeSizes(input) {
  let arr;
  if (Array.isArray(input)) {
    arr = input;
  } else if (typeof input === "string") {
    arr = input.split(",");
  } else {
    return [];
  }
  return arr
    .map((s) => (s == null ? "" : String(s).trim()))
    .filter((s) => s !== "");
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
      .from("size_scales")
      .select("*")
      .eq("entity_id", entityId)
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`code.ilike.%${esc}%,name.ilike.%${esc}%`);
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
      admin, "size_scales", "code", CODE_PREFIX, buildRow, { entityId },
    );
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Could not allocate a unique size-scale code; please retry" });
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
  // `code` is server-generated (SCALE-NNNNN); no longer required from the client.
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }

  const sizes = normalizeSizes(body.sizes);
  if (sizes.length === 0) {
    return { error: "at least one size is required" };
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

  return {
    data: {
      // code is injected by the handler (server-generated); not taken from body.
      name:       String(body.name).trim(),
      sizes,
      sort_order: sortOrder,
      is_active:  isActive,
    },
  };
}
