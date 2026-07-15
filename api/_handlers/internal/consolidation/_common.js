// api/_handlers/internal/consolidation/_common.js
//
// Shared helpers for the multi-entity Consolidation endpoints. NOT a route
// (leading underscore) — the routing manifest never maps to it.

import { createClient } from "@supabase/supabase-js";

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const BASIS_VALUES = ["ACCRUAL", "CASH"];
export const DEFAULT_GROUP_CODE = "ROF_CONSOLIDATED";

export function corsHeaders(res, methods = "GET, OPTIONS") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", `${methods}`);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

export function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the consolidation group by id OR code (defaults to ROF_CONSOLIDATED).
 * Returns the full group row, or null if not found.
 */
export async function resolveGroup(admin, groupParam) {
  const raw = (groupParam || "").toString().trim();
  let query = admin.from("consolidation_groups").select("*");
  if (!raw) query = query.eq("code", DEFAULT_GROUP_CODE);
  else if (UUID_RE.test(raw)) query = query.eq("id", raw);
  else query = query.eq("code", raw);
  const { data } = await query.maybeSingle();
  return data || null;
}

/**
 * Ordered, included, non-SANDBOX member entities of a group.
 * Returns [{ entity_id, entity_code, entity_name, display_order }].
 */
export async function groupMemberEntities(admin, groupId) {
  const { data, error } = await admin.rpc("consol_member_entities", { p_group_id: groupId });
  if (error) throw new Error(error.message);
  return data || [];
}
