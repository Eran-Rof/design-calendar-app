// api/internal/part-master
//
// GET  — list parts for the default entity. is_active=true only by default;
//        ?include_inactive=true returns all. ?q=<search> ilike-matches code,
//        name; ?part_type=<t> filters by type.
// POST — create one part_master row. Body:
//          { name (required),
//            part_type (blank_garment|label|trim|packaging|fabric|generic),
//            uom, default_vendor_id, default_unit_cost_cents, is_size_scaled,
//            fabric_code_id, notes, sort_order, is_active }
//          `code` is SERVER-GENERATED (PART-NNNNN); client code is ignored.
//
// Tangerine — Manufacturing Part Master. Mirrors the fabric-mills handler shape
// (resolveDefaultEntityId + ROF scope; service-role writes; anon-read in DB).

import { createClient } from "@supabase/supabase-js";
import { insertWithAutoCode } from "../../../_lib/autoCode.js";

export const config = { maxDuration: 15 };

const CODE_PREFIX = "PART-";
// part_type is now driven by the Part Type Master (part_type_master); any
// non-empty code is accepted here and the UI constrains the picker to the master.
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
    const partType = (url.searchParams.get("part_type") || "").trim();

    let query = admin
      .from("part_master")
      .select("*")
      .eq("entity_id", entityId)
      // Per-size CHILD rows (parent_part_id set) are internal to a matrix part —
      // the list shows parents + non-matrix parts, not the exploded per-size rows.
      .is("parent_part_id", null)
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (partType) query = query.eq("part_type", partType);
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

    const buildRow = (code) => ({ ...v.data, code, entity_id: entityId });

    const { data, error } = await insertWithAutoCode(
      admin, "part_master", "code", CODE_PREFIX, buildRow, { entityId },
    );
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Could not allocate a unique part code; please retry" });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function parseCents(val) {
  if (val == null || val === "") return { value: null };
  const n = typeof val === "number" ? val : parseInt(val, 10);
  if (!Number.isInteger(n) || n < 0) return { error: "cost must be a non-negative integer (cents)" };
  return { value: n };
}

export function validateInsert(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }

  const partType = body.part_type == null || String(body.part_type).trim() === ""
    ? "generic" : String(body.part_type).trim();

  let sortOrder = 0;
  if (body.sort_order != null && body.sort_order !== "") {
    sortOrder = typeof body.sort_order === "number" ? body.sort_order : parseInt(body.sort_order, 10);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return { error: "sort_order must be a non-negative integer" };
    }
  }

  const cost = parseCents(body.default_unit_cost_cents);
  if (cost.error) return { error: `default_unit_cost_cents: ${cost.error}` };

  for (const fk of ["default_vendor_id", "fabric_code_id"]) {
    if (body[fk] != null && body[fk] !== "" && !UUID_RE.test(String(body[fk]))) {
      return { error: `${fk} must be a uuid` };
    }
  }

  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;
  const isSizeScaled = body.is_size_scaled == null ? false :
    typeof body.is_size_scaled === "boolean" ? body.is_size_scaled :
      body.is_size_scaled === "true" || body.is_size_scaled === 1;
  // Matrix (by-size) part — a size-scaled PARENT whose per-size children hold the
  // inventory (P2). A matrix part is implicitly size-scaled.
  const isMatrix = body.is_matrix === true || body.is_matrix === "true" || body.is_matrix === 1;
  if (body.size_scale_id != null && body.size_scale_id !== "" && !UUID_RE.test(String(body.size_scale_id))) {
    return { error: "size_scale_id must be a uuid" };
  }

  const data = {
    name:           String(body.name).trim(),
    part_type:      partType,
    uom:            body.uom != null && String(body.uom).trim() ? String(body.uom).trim() : "each",
    is_size_scaled: isSizeScaled || isMatrix,
    is_matrix:      isMatrix,
    size_scale_id:  isMatrix && body.size_scale_id ? String(body.size_scale_id) : null,
    sort_order:     sortOrder,
    is_active:      isActive,
    default_unit_cost_cents: cost.value,
    default_vendor_id: body.default_vendor_id ? String(body.default_vendor_id) : null,
    fabric_code_id:    body.fabric_code_id ? String(body.fabric_code_id) : null,
  };
  if (body.notes != null) data.notes = String(body.notes).trim() || null;

  return { data };
}
