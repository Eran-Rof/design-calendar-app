// api/internal/service-items
//
// GET  — list service items for the default entity. is_active=true only by
//        default; ?include_inactive=true returns all. ?q=<search> ilike-matches
//        code, name; ?service_kind=<k> filters by kind.
// POST — create one service_item_master row. Body:
//          { name (required),
//            service_kind (print|sew|pack|wash|conversion|other),
//            is_labor, default_vendor_id, default_charge_cents,
//            default_expense_account_id, applied_to_wip, notes, sort_order,
//            is_active }
//          `code` is SERVER-GENERATED (SVC-NNNNN); client code is ignored.
//
// Tangerine — Manufacturing Service Item Master (conversion/labor charges).

import { createClient } from "@supabase/supabase-js";
import { insertWithAutoCode } from "../../../_lib/autoCode.js";

export const config = { maxDuration: 15 };

const CODE_PREFIX = "SVC-";
const SERVICE_KINDS = new Set(["print", "sew", "pack", "wash", "conversion", "other"]);
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
    const kind = (url.searchParams.get("service_kind") || "").trim();

    let query = admin
      .from("service_item_master")
      .select("*")
      .eq("entity_id", entityId)
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (kind && SERVICE_KINDS.has(kind)) query = query.eq("service_kind", kind);
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
      admin, "service_item_master", "code", CODE_PREFIX, buildRow, { entityId },
    );
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Could not allocate a unique service code; please retry" });
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

  const kind = body.service_kind == null ? "conversion" : String(body.service_kind).trim();
  if (!SERVICE_KINDS.has(kind)) {
    return { error: `service_kind must be one of: ${[...SERVICE_KINDS].join(", ")}` };
  }

  let sortOrder = 0;
  if (body.sort_order != null && body.sort_order !== "") {
    sortOrder = typeof body.sort_order === "number" ? body.sort_order : parseInt(body.sort_order, 10);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return { error: "sort_order must be a non-negative integer" };
    }
  }

  let charge = null;
  if (body.default_charge_cents != null && body.default_charge_cents !== "") {
    charge = typeof body.default_charge_cents === "number"
      ? body.default_charge_cents : parseInt(body.default_charge_cents, 10);
    if (!Number.isInteger(charge) || charge < 0) {
      return { error: "default_charge_cents must be a non-negative integer (cents)" };
    }
  }

  for (const fk of ["default_vendor_id", "default_expense_account_id"]) {
    if (body[fk] != null && body[fk] !== "" && !UUID_RE.test(String(body[fk]))) {
      return { error: `${fk} must be a uuid` };
    }
  }

  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;
  const isLabor = body.is_labor == null ? true :
    typeof body.is_labor === "boolean" ? body.is_labor :
      body.is_labor === "true" || body.is_labor === 1;
  const appliedToWip = body.applied_to_wip == null ? true :
    typeof body.applied_to_wip === "boolean" ? body.applied_to_wip :
      body.applied_to_wip === "true" || body.applied_to_wip === 1;

  const data = {
    name:           String(body.name).trim(),
    service_kind:   kind,
    is_labor:       isLabor,
    applied_to_wip: appliedToWip,
    sort_order:     sortOrder,
    is_active:      isActive,
    default_charge_cents:       charge,
    default_vendor_id:          body.default_vendor_id ? String(body.default_vendor_id) : null,
    default_expense_account_id: body.default_expense_account_id ? String(body.default_expense_account_id) : null,
  };
  if (body.notes != null) data.notes = String(body.notes).trim() || null;

  return { data };
}
