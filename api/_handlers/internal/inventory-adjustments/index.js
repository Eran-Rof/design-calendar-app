// api/internal/inventory-adjustments
//
// Tangerine P3-5 — M37 inventory adjustments (arch §5.2/§5.3).
//
// GET  — list adjustments. Filters:
//          ?item_id=<uuid>            exact match
//          ?adjustment_type=<str>     one of damage/shrinkage/found/...
//          ?posted=true|false         filter by posted_je_id presence
//          ?from=YYYY-MM-DD&to=YYYY-MM-DD  inclusive created_at range
//          ?limit=<n>                 1-500, default 100
//        Default ordering: created_at DESC.
//
// POST — create one (draft). Body:
//          { item_id, adjustment_type, qty_delta, unit_cost_cents?, reason,
//            gl_account_id }
//        unit_cost_cents required iff qty_delta > 0 (CHECK constraint).
//        Row lands with posted_je_id=NULL → draft. Operator runs `/post`
//        to actually emit the JE + FIFO side effects.
//
// Subpath /:id/post lives in ./post.js (subpath-before-:id ordering in routes.js).

import { createClient } from "@supabase/supabase-js";
import { applyBrandScope } from "../../../_lib/brandContext.js";

export const config = { maxDuration: 15 };

const VALID_TYPES = ["damage","shrinkage","found","correction","write_off","return_to_vendor"];

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
  const out = { filters: {}, limit: 100 };

  const itemId = (searchParams.get("item_id") || "").trim();
  if (itemId) {
    if (!isUuid(itemId)) return { error: "item_id must be a uuid" };
    out.filters.item_id = itemId;
  }

  const adjType = (searchParams.get("adjustment_type") || "").trim();
  if (adjType) {
    if (!VALID_TYPES.includes(adjType)) {
      return { error: `adjustment_type must be one of ${VALID_TYPES.join("|")}` };
    }
    out.filters.adjustment_type = adjType;
  }

  const posted = searchParams.get("posted");
  if (posted === "true") out.filters.posted = true;
  else if (posted === "false") out.filters.posted = false;
  else if (posted != null && posted !== "") {
    return { error: "posted must be 'true' or 'false'" };
  }

  const from = (searchParams.get("from") || "").trim();
  if (from) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return { error: "from must be YYYY-MM-DD" };
    out.filters.from = from;
  }
  const to = (searchParams.get("to") || "").trim();
  if (to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return { error: "to must be YYYY-MM-DD" };
    out.filters.to = to;
  }

  const limitRaw = searchParams.get("limit");
  if (limitRaw != null && limitRaw !== "") {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n <= 0) return { error: "limit must be a positive integer" };
    out.limit = Math.min(n, 500);
  }

  return out;
}

// Validate insert body. Returns { error } or { data }.
// qty_delta sign drives whether unit_cost_cents is required (positive) or
// must be NULL (negative). The DB CHECK constraint repeats this guard.
export function validateInsert(body) {
  if (!body || typeof body !== "object") return { error: "body required" };

  if (!body.item_id || !isUuid(String(body.item_id))) {
    return { error: "item_id (uuid) required" };
  }
  if (!body.adjustment_type || !VALID_TYPES.includes(body.adjustment_type)) {
    return { error: `adjustment_type required, one of ${VALID_TYPES.join("|")}` };
  }
  if (body.qty_delta == null || body.qty_delta === "") {
    return { error: "qty_delta required" };
  }
  const qty = Number(body.qty_delta);
  if (!Number.isFinite(qty) || qty === 0) {
    return { error: "qty_delta must be a non-zero number" };
  }
  if (!body.reason || !String(body.reason).trim()) {
    return { error: "reason (non-empty) required" };
  }
  if (!body.gl_account_id || !isUuid(String(body.gl_account_id))) {
    return { error: "gl_account_id (uuid) required" };
  }

  let unitCost = null;
  if (qty > 0) {
    if (body.unit_cost_cents == null || body.unit_cost_cents === "") {
      return { error: "unit_cost_cents required when qty_delta > 0" };
    }
    const n = Number(body.unit_cost_cents);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { error: "unit_cost_cents must be a non-negative integer (cents)" };
    }
    unitCost = n;
  } else {
    // qty < 0 — unit_cost_cents must be omitted / null (CHECK constraint)
    if (body.unit_cost_cents != null && body.unit_cost_cents !== "") {
      return { error: "unit_cost_cents must be omitted when qty_delta < 0 (FIFO-derived at post)" };
    }
  }

  return {
    data: {
      item_id: String(body.item_id),
      adjustment_type: body.adjustment_type,
      qty_delta: qty,
      unit_cost_cents: unitCost,
      reason: String(body.reason).trim(),
      gl_account_id: String(body.gl_account_id),
    },
  };
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
    const parsed = parseListQuery(url.searchParams);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let query = admin
      .from("inventory_adjustments")
      .select("*")
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .limit(parsed.limit);

    // P15 C3 — brand scoping (no-op unless BRAND_SCOPE_MODE=enforce + a brand selected).
    query = applyBrandScope(query, req);

    if (parsed.filters.item_id) query = query.eq("item_id", parsed.filters.item_id);
    if (parsed.filters.adjustment_type) query = query.eq("adjustment_type", parsed.filters.adjustment_type);
    if (parsed.filters.posted === true) query = query.not("posted_je_id", "is", null);
    if (parsed.filters.posted === false) query = query.is("posted_je_id", null);
    if (parsed.filters.from) query = query.gte("created_at", parsed.filters.from);
    if (parsed.filters.to) query = query.lte("created_at", `${parsed.filters.to}T23:59:59.999Z`);

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

    const created_by_user_id = body && typeof body.created_by_user_id === "string" && isUuid(body.created_by_user_id)
      ? body.created_by_user_id
      : null;

    const insertRow = {
      ...v.data,
      entity_id: entityId,
      created_by_user_id,
    };

    const { data, error } = await admin
      .from("inventory_adjustments")
      .insert(insertRow)
      .select()
      .single();

    if (error) {
      // 23514 = CHECK violation (qty/cost mismatch caught at DB)
      if (error.code === "23514") {
        return res.status(400).json({ error: `Constraint failed: ${error.message}`, code: error.code });
      }
      // 23503 = FK violation (item_id / gl_account_id not found)
      if (error.code === "23503") {
        return res.status(400).json({ error: `Foreign key violation: ${error.message}`, code: error.code });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
