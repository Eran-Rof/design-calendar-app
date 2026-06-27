// api/internal/date-presets
//
// GET  — list operator-defined date presets for the default entity. Default
//        returns is_active=true only; ?include_inactive=true returns all.
// POST — create one date_preset_master row. Body:
//          { label (required), kind (required, valid expression),
//            n (int, required for last_n_days/last_n_months), sort_order?, is_active? }
//
// User-extendable additional date-range presets (operator). Merged with the
// code-side DEFAULT_PRESETS by the <DateRangePresets/> selector. Mirrors the
// adjustment-types master handler (ROF entity scope; service-role writes).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const VALID_KINDS = new Set([
  "last_n_days", "last_n_months", "mtd", "ytd", "this_year", "last_year",
  "this_month", "last_month", "this_quarter", "last_quarter", "ty_to_last_month",
  "today", "yesterday",
]);
const N_KINDS = new Set(["last_n_days", "last_n_months"]);

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
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
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
    let q = admin.from("date_preset_master").select("*").eq("entity_id", entityId)
      .order("sort_order", { ascending: true }).order("label", { ascending: true });
    if (!includeInactive) q = q.eq("is_active", true);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const { data, error } = await admin.from("date_preset_master")
      .insert({ ...v.data, entity_id: entityId }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  const label = String(body.label ?? "").trim();
  if (!label) return { error: "label is required" };
  const kind = String(body.kind ?? "").trim();
  if (!VALID_KINDS.has(kind)) return { error: `kind must be one of: ${[...VALID_KINDS].join(", ")}` };
  let n = null;
  if (N_KINDS.has(kind)) {
    n = parseInt(body.n, 10);
    if (!Number.isInteger(n) || n <= 0) return { error: `n (a positive integer) is required for ${kind}` };
  }
  let sortOrder = 0;
  if (body.sort_order != null && body.sort_order !== "") {
    sortOrder = parseInt(body.sort_order, 10);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) return { error: "sort_order must be a non-negative integer" };
  }
  const isActive = body.is_active == null ? true
    : typeof body.is_active === "boolean" ? body.is_active : body.is_active === "true" || body.is_active === 1;
  return { data: { label, kind, n, sort_order: sortOrder, is_active: isActive, created_by_user_id: body.created_by_user_id || null } };
}
